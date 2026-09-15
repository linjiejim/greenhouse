//! Screen capture.
//!
//! macOS shells out to the built-in `screencapture`, which gives the real system
//! crosshair, window picker and Escape-to-cancel for free — reimplementing that with
//! an overlay window would be a lot of code for a worse result. Windows has no
//! equivalent, so it captures the full screen and the web layer crops.
//!
//! Output is sized to survive `/api/upload` (5 MB, see `apps/api/src/routes/upload.ts`):
//! anything larger is re-encoded to JPEG and, if still too big, downscaled. Screenshots
//! exist here to be read by a vision model, and q80 JPEG is indistinguishable for that.

use super::{Availability, Permission};
use serde::{Deserialize, Serialize};

/// Stay clear of the API's 5 MB cap — base64 inflates by ~4/3 and multipart adds framing.
const MAX_UPLOAD_BYTES: usize = 3_500_000;
/// Longest edge after downscaling; well beyond what any vision model resolves.
const MAX_EDGE: u32 = 2400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    /// Drag out a region (macOS: Space switches to window picking, Esc cancels).
    Interactive,
    /// Click a window to capture it.
    Window,
    /// The whole main display, no interaction.
    Full,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub mime: String,
    /// Raw base64 (no data-URL prefix) — the web layer builds a Blob from it.
    pub base64: String,
    pub width: u32,
    pub height: u32,
}

/// `None` means the user cancelled, which is not an error and must not be shown as one.
pub type CaptureOutcome = Option<Capture>;

pub fn availability() -> Availability {
    #[cfg(target_os = "macos")]
    {
        if super::perms::status().screen_recording {
            Availability::Available
        } else {
            Availability::NeedsPermission {
                permission: Permission::ScreenRecording,
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        Availability::Available
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = Permission::ScreenRecording;
        Availability::unsupported("Screen capture is implemented for macOS and Windows only")
    }
}

pub fn capture(mode: CaptureMode) -> Result<CaptureOutcome, String> {
    let raw = capture_png(mode)?;
    let Some(raw) = raw else { return Ok(None) };
    Ok(Some(encode_for_upload(raw)?))
}

#[cfg(target_os = "macos")]
fn capture_png(mode: CaptureMode) -> Result<Option<Vec<u8>>, String> {
    use std::process::Command;

    let dir = tempfile::tempdir().map_err(|e| format!("could not create a temp dir: {e}"))?;
    let path = dir.path().join("greenhouse-capture.png");

    // -x silences the shutter sound; the app is capturing on the user's behalf and
    // the sound reads as "something happened by itself".
    let mut cmd = Command::new("screencapture");
    cmd.arg("-x");
    match mode {
        CaptureMode::Interactive => {
            cmd.arg("-i");
        }
        CaptureMode::Window => {
            cmd.args(["-i", "-w"]);
        }
        CaptureMode::Full => {}
    }
    cmd.arg(&path);

    let status = cmd
        .status()
        .map_err(|e| format!("could not run screencapture: {e}"))?;
    if !status.success() {
        return Err(format!("screencapture exited with {status}"));
    }

    // On cancel, screencapture still exits 0 but writes nothing.
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read(&path)
        .map(Some)
        .map_err(|e| format!("could not read the capture: {e}"))
}

#[cfg(target_os = "windows")]
fn capture_png(_mode: CaptureMode) -> Result<Option<Vec<u8>>, String> {
    // Windows has no built-in interactive capture we can drive, so every mode takes
    // the primary monitor whole. `capabilities.ts` tells the user this before they
    // pick a mode, rather than silently handing back the wrong picture.
    let monitor = xcap::Monitor::all()
        .map_err(|e| format!("could not enumerate monitors: {e}"))?
        .into_iter()
        .next()
        .ok_or_else(|| "no monitor found".to_string())?;
    let image = monitor
        .capture_image()
        .map_err(|e| format!("could not capture the screen: {e}"))?;

    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("could not encode the capture: {e}"))?;
    Ok(Some(png.into_inner()))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn capture_png(_mode: CaptureMode) -> Result<Option<Vec<u8>>, String> {
    Err("Screen capture is implemented for macOS and Windows only".into())
}

/// Progressively harsher (longest edge, JPEG quality) attempts.
///
/// A single downscale+encode pass is *not* a guarantee: a dense enough screenshot
/// still lands over the cap at 2400px/q80. Since the whole point is that the result
/// uploads, the ladder keeps going until it actually fits.
const ENCODE_LADDER: &[(u32, u8)] = &[
    (MAX_EDGE, 80),
    (MAX_EDGE, 60),
    (1800, 60),
    (1400, 50),
    (1000, 40),
    (800, 30),
];

/// Shrink a capture until it will survive the upload endpoint, cheapest step first.
fn encode_for_upload(png: Vec<u8>) -> Result<Capture, String> {
    if png.len() <= MAX_UPLOAD_BYTES {
        let (width, height) =
            png_dimensions(&png).ok_or_else(|| "capture is not a readable PNG".to_string())?;
        return Ok(Capture {
            mime: "image/png".into(),
            base64: encode_base64(&png),
            width,
            height,
        });
    }

    let decoded =
        image::load_from_memory(&png).map_err(|e| format!("could not decode the capture: {e}"))?;

    let mut smallest: Option<Capture> = None;
    for &(edge, quality) in ENCODE_LADDER {
        let resized = if decoded.width().max(decoded.height()) > edge {
            decoded.resize(edge, edge, image::imageops::FilterType::Lanczos3)
        } else {
            decoded.clone()
        };
        let rgb = resized.to_rgb8();

        let mut jpeg = std::io::Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality)
            .encode_image(&rgb)
            .map_err(|e| format!("could not re-encode the capture: {e}"))?;
        let bytes = jpeg.into_inner();

        let fits = bytes.len() <= MAX_UPLOAD_BYTES;
        let capture = Capture {
            mime: "image/jpeg".into(),
            base64: encode_base64(&bytes),
            width: rgb.width(),
            height: rgb.height(),
        };
        if fits {
            return Ok(capture);
        }
        smallest = Some(capture);
    }

    // Nothing in the ladder fit. Fail here with something the user can act on rather
    // than letting /api/upload reject it later with an opaque 413.
    let _ = smallest;
    Err("This capture is too detailed to upload even after downscaling — try capturing a smaller region".into())
}

fn encode_base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Read width/height straight from the PNG IHDR, to avoid decoding a whole
/// full-screen image just to report its size.
fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() < 24 || !bytes.starts_with(SIGNATURE) || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_png() -> Vec<u8> {
        let image = image::RgbaImage::new(7, 3);
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn reads_dimensions_from_the_png_header() {
        assert_eq!(png_dimensions(&tiny_png()), Some((7, 3)));
    }

    #[test]
    fn rejects_non_png_bytes() {
        assert_eq!(png_dimensions(b"not a png at all, really not"), None);
        assert_eq!(png_dimensions(&[]), None);
    }

    #[test]
    fn small_captures_pass_through_as_png() {
        let capture = encode_for_upload(tiny_png()).unwrap();
        assert_eq!(capture.mime, "image/png");
        assert_eq!((capture.width, capture.height), (7, 3));
        assert!(!capture.base64.is_empty());
    }

    #[test]
    fn oversized_captures_are_re_encoded_and_downscaled_under_the_upload_cap() {
        // Noise, so PNG can't compress it away and we actually exercise the branch.
        let mut image = image::RgbImage::new(4000, 3000);
        let mut seed: u32 = 12345;
        for pixel in image.pixels_mut() {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *pixel = image::Rgb([(seed >> 16) as u8, (seed >> 8) as u8, seed as u8]);
        }
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let png = png.into_inner();
        assert!(
            png.len() > MAX_UPLOAD_BYTES,
            "test fixture must exceed the cap"
        );

        let capture = encode_for_upload(png).unwrap();
        assert_eq!(capture.mime, "image/jpeg");
        // Pure noise is the worst case for JPEG; one pass at 2400px/q80 is NOT enough,
        // so the ladder has to keep stepping down. Assert the invariant, not a fixed size.
        assert!(capture.width.max(capture.height) <= MAX_EDGE);
        // The point of the whole branch: the result must actually be uploadable.
        let decoded_len = capture.base64.len() * 3 / 4;
        assert!(
            decoded_len <= MAX_UPLOAD_BYTES,
            "re-encoded capture is still {decoded_len} bytes"
        );
    }
}
