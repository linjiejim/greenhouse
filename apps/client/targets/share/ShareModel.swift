import Foundation
import Security
import UniformTypeIdentifiers

/// The station + access token the app keeps for this extension (src/share/payload.ts).
struct ShareSession: Decodable {
  let v: Int
  let stationId: String
  let stationName: String
  let baseUrl: String
  let accessToken: String
  let memberName: String
  let expiresAt: Double?
  /// The app's language ("zh" / "en"); absent from sessions written by older builds.
  let lang: String?

  var expired: Bool {
    guard let expiresAt else { return false }
    return Date().timeIntervalSince1970 >= expiresAt - 30
  }

  /// The keychain item the app writes (expo-secure-store, account = the key's UTF-8 bytes).
  static func load() -> ShareSession? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: Data("greenhouse.share.session".utf8),
      kSecAttrAccessGroup as String: "group.app.greenhouse.mobile",
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data,
      let session = try? JSONDecoder().decode(ShareSession.self, from: data),
      session.v == 1,
      let url = URL(string: session.baseUrl),
      url.scheme == "https" || url.scheme == "http"
    else { return nil }
    return session
  }
}

enum Shelf: String, CaseIterable, Identifiable {
  case team
  case personal
  var id: String { rawValue }
  var visibility: String { self == .personal ? "private" : "team" }
}

struct Folder: Decodable, Identifiable, Hashable {
  let id: Int
  let name: String
  let parent_id: Int?
}

/// One shared item, copied into this extension's temporary directory.
struct SharedFile {
  let url: URL
  let name: String
  let size: Int
  let mimeType: String
}

enum ShareError: Error {
  case signedOut
  /// The server answered with an error status (see ShareLogic.swift `UploadFailure`).
  case http(Int, String)
  case network
}

struct ShareAPI {
  let session: ShareSession

  private func request(_ path: String, method: String = "GET", json: Any? = nil) throws -> URLRequest {
    guard let url = URL(string: session.baseUrl + path) else { throw ShareError.network }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
    if let json {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: json)
    }
    return request
  }

  private func check(_ response: URLResponse, _ data: Data) throws {
    guard let http = response as? HTTPURLResponse else { throw ShareError.network }
    if http.statusCode == 401 { throw ShareError.signedOut }
    guard (200..<300).contains(http.statusCode) else {
      let words = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
      throw ShareError.http(http.statusCode, words ?? "HTTP \(http.statusCode)")
    }
  }

  func folders(shelf: Shelf, parent: Int?) async throws -> [Folder] {
    var path = "/api/drive/folders?scope=kb&visibility=\(shelf.visibility)"
    if let parent { path += "&parent_id=\(parent)" }
    let (data, response) = try await URLSession.shared.data(for: request(path))
    try check(response, data)
    struct Answer: Decodable { let folders: [Folder] }
    return try JSONDecoder().decode(Answer.self, from: data).folders.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }

  /// init → bytes (to the presigned URL, or through the API) → complete.
  func upload(_ file: SharedFile, shelf: Shelf, folder: Int?) async throws {
    var body: [String: Any] = [
      "scope": "kb", "visibility": shelf.visibility, "name": file.name, "size": file.size, "content_type": file.mimeType,
    ]
    if let folder { body["folder_id"] = folder }
    let (initData, initResponse) = try await URLSession.shared.data(for: request("/api/drive/files/init", method: "POST", json: body))
    try check(initResponse, initData)
    guard let started = try JSONSerialization.jsonObject(with: initData) as? [String: Any],
      let fileId = started["file_id"] as? Int,
      let mode = started["mode"] as? String,
      let uploadUrl = started["upload_url"] as? String
    else { throw ShareError.network }

    var put: URLRequest
    if mode == "proxy" {
      put = try request(uploadUrl, method: "PUT")
    } else {
      guard let url = URL(string: uploadUrl) else { throw ShareError.network }
      put = URLRequest(url: url)
      put.httpMethod = "PUT"
    }
    put.setValue(file.mimeType, forHTTPHeaderField: "Content-Type")
    let (putData, putResponse) = try await URLSession.shared.upload(for: put, fromFile: file.url)
    try check(putResponse, putData)
    if mode != "proxy" {
      let (doneData, doneResponse) = try await URLSession.shared.data(
        for: request("/api/drive/files/\(fileId)/complete", method: "POST", json: [String: Any]()))
      try check(doneResponse, doneData)
    }
  }
}

/// Copy every shared attachment into a temporary file the upload can stream from.
func collectSharedFiles(_ items: [NSExtensionItem]) async -> [SharedFile] {
  var files: [SharedFile] = []
  let providers = items.flatMap { $0.attachments ?? [] }
  for provider in providers {
    guard let type = provider.registeredTypeIdentifiers.compactMap(UTType.init).first(where: { $0.conforms(to: .data) })
    else { continue }
    if let file = await copy(provider, type: type) { files.append(file) }
  }
  return files
}

private func copy(_ provider: NSItemProvider, type: UTType) async -> SharedFile? {
  await withCheckedContinuation { continuation in
    _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
      guard let url else {
        continuation.resume(returning: nil)
        return
      }
      let ext = url.pathExtension.isEmpty ? (type.preferredFilenameExtension ?? "bin") : url.pathExtension
      let stem = provider.suggestedName ?? url.deletingPathExtension().lastPathComponent
      let name = stem.hasSuffix(".\(ext)") ? stem : "\(stem).\(ext)"
      let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
      let target = dir.appendingPathComponent(name)
      do {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: url, to: target)
        let size = (try? FileManager.default.attributesOfItem(atPath: target.path)[.size] as? Int) ?? 0
        let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? type.preferredMIMEType ?? "application/octet-stream"
        continuation.resume(returning: SharedFile(url: target, name: name, size: size, mimeType: mime))
      } catch {
        continuation.resume(returning: nil)
      }
    }
  }
}

/// The extension's words, in the app's language (else the phone's): Chinese or English.
enum L {
  static let zh = shareUsesChinese(appLanguage: ShareSession.load()?.lang, preferred: Locale.preferredLanguages)
  static func t(_ en: String, _ zhText: String) -> String { zh ? zhText : en }
}
