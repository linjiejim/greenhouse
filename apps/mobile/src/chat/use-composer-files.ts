/**
 * The composer's files: pick from the camera, the photo library or Files, upload each at once and
 * retry in place (src/api/chat-files.ts). Pictures are scaled down and go up as message pictures;
 * other files are attached to the conversation, so they need one: `ensureSession` gives it (home
 * makes the conversation the first time a file is picked). Sending waits for all of them
 * (./composer-files.ts). Every upload belongs to the station + member that picked it.
 */

import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { Linking } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { prepareImage, uploadChatFile, uploadImage } from '../api/chat-files';
import { captureIdentity } from '../data/identity';
import { t } from '../lib/i18n';
import { alertError, confirmAction } from '../ui/dialogs';
import { MAX_FILES, uploadsAsImage, type ComposerFile } from './composer-files';

let seq = 0;
const localId = () => `file-${Date.now().toString(36)}-${++seq}`;

export type AttachSource = 'camera' | 'library' | 'files';

export function useComposerFiles(ensureSession: () => Promise<string | null>) {
  const [files, updateFiles] = useState<ComposerFile[]>([]);
  const current = useRef(files);
  const mounted = useRef(true);
  const picking = useRef(false);
  const session = useRef(ensureSession);
  session.current = ensureSession;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // synchronous claim: a second tap cannot start the same retry or overfill the draft
  const setFiles = useCallback((next: SetStateAction<ComposerFile[]>) => {
    current.current = typeof next === 'function' ? next(current.current) : next;
    updateFiles(current.current);
  }, []);

  const upload = useCallback(
    async (picked: ComposerFile[]) => {
      const identity = captureIdentity();
      let failed: string | null = null;
      for (const file of picked) {
        const still = () => mounted.current && identity() && current.current.some((item) => item.id === file.id);
        if (!still()) continue;
        let remote: ComposerFile['remote'] | null = null;
        if (file.kind === 'image') {
          const prepared = await prepareImage(file.uri, file.width, file.height);
          if (!still()) continue;
          const result = await uploadImage(prepared.uri);
          if (result.ok) remote = { kind: 'image', image: { id: result.data.id, url: result.data.url } };
          else failed = result.message || failed || '';
        } else {
          const sessionId = await session.current();
          if (!still()) continue;
          const result = sessionId ? await uploadChatFile(sessionId, file.uri, file.name) : null;
          if (result?.ok)
            remote = { kind: 'file', file: { id: result.data.id, name: result.data.name, size: result.data.size } };
          else failed = result?.message || failed || '';
        }
        if (!still()) continue;
        setFiles((all) =>
          all.map((item) =>
            item.id !== file.id ? item : remote ? { ...item, status: 'done', remote } : { ...item, status: 'error' },
          ),
        );
      }
      if (mounted.current && failed !== null) alertError(t('composer.uploadFailed'), failed || undefined);
    },
    [setFiles],
  );

  const retry = useCallback(() => {
    const failed = current.current.filter((file) => file.status === 'error');
    if (!failed.length) return;
    setFiles((all) => all.map((file) => (file.status === 'error' ? { ...file, status: 'uploading' } : file)));
    void upload(failed);
  }, [setFiles, upload]);

  const attach = useCallback(
    async (from: AttachSource) => {
      if (picking.current) return;
      const room = MAX_FILES - current.current.length;
      if (room <= 0) {
        alertError(t('composer.maxFiles', { n: MAX_FILES }));
        return;
      }
      picking.current = true;
      try {
        let picked: ComposerFile[] = [];
        if (from === 'files') {
          const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
          if (result.canceled || !mounted.current) return;
          picked = result.assets.slice(0, room).map((asset) => ({
            id: localId(),
            uri: asset.uri,
            name: asset.name,
            kind: uploadsAsImage(asset.mimeType ?? undefined, asset.name) ? 'image' : 'file',
            mimeType: asset.mimeType ?? undefined,
            size: asset.size ?? undefined,
            status: 'uploading',
          }));
        } else {
          if (from === 'camera') {
            const permission = await ImagePicker.requestCameraPermissionsAsync();
            if (!permission.granted) {
              const go = await confirmAction({
                title: t('composer.cameraDenied'),
                message: t('composer.cameraDeniedHint'),
                confirmLabel: t('composer.openSettings'),
              });
              if (go) void Linking.openSettings();
              return;
            }
          }
          const result =
            from === 'camera'
              ? await ImagePicker.launchCameraAsync({ quality: 0.9 })
              : await ImagePicker.launchImageLibraryAsync({
                  mediaTypes: ['images'],
                  allowsMultipleSelection: true,
                  selectionLimit: room,
                  quality: 0.9,
                });
          if (result.canceled || !mounted.current) return;
          picked = result.assets.slice(0, room).map((asset) => ({
            id: localId(),
            uri: asset.uri,
            name: asset.fileName || `photo-${Date.now()}.jpg`,
            kind: 'image',
            width: asset.width,
            height: asset.height,
            mimeType: asset.mimeType || 'image/jpeg',
            size: asset.fileSize,
            status: 'uploading',
          }));
        }
        picked = picked.slice(0, MAX_FILES - current.current.length);
        if (!picked.length) return;
        // everything picked shows at once, including the files waiting their turn to upload
        setFiles((all) => [...all, ...picked]);
        void upload(picked);
      } catch {
        if (mounted.current) alertError(t('composer.uploadFailed'));
      } finally {
        picking.current = false;
      }
    },
    [setFiles, upload],
  );

  const remove = useCallback((id: string) => setFiles((all) => all.filter((file) => file.id !== id)), [setFiles]);
  const clear = useCallback(() => setFiles([]), [setFiles]);
  return { files, attach, remove, retry, clear };
}
