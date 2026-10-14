/**
 * The composer's files: pick from the camera, the photo library or Files, upload each at once
 * (`POST /api/files`, purpose attachment, into this conversation when it exists), retry in place.
 * Pictures are scaled down before they go. Sending waits for all of them (./composer-files.ts).
 */
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { Linking } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { prepareImage, uploadFile } from '../api/files';
import { t } from '../lib/i18n';
import { alertError, confirmAction } from '../ui/dialogs';
import { MAX_FILES, recoverDraftFiles, type ComposerFile } from './composer-files';

let seq = 0;
const localId = () => `file-${Date.now().toString(36)}-${++seq}`;

export type AttachSource = 'camera' | 'library' | 'files';

export function useComposerFiles(conversationId: string | null, initial: ComposerFile[] = []) {
  const [files, updateFiles] = useState(() => recoverDraftFiles(initial));
  const current = useRef(files);
  const mounted = useRef(true);
  const picking = useRef(false);
  const target = useRef(conversationId);
  target.current = conversationId;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Synchronous claim: a second tap cannot start the same retry or overfill the draft.
  const setFiles = useCallback((next: SetStateAction<ComposerFile[]>) => {
    current.current = typeof next === 'function' ? next(current.current) : next;
    updateFiles(current.current);
  }, []);

  const upload = useCallback(
    async (picked: ComposerFile[]) => {
      let failed: string | null = null;
      for (const file of picked) {
        const still = () => mounted.current && current.current.some((item) => item.id === file.id);
        if (!still()) continue;
        const uri = file.kind === 'image' ? await prepareImage(file.uri, file.width) : file.uri;
        if (!still()) continue;
        const scaled = uri !== file.uri;
        const result = await uploadFile(uri, {
          name: scaled ? file.name.replace(/\.[^.]+$/, '') + '.jpg' : file.name,
          type: scaled ? 'image/jpeg' : (file.mimeType ?? 'application/octet-stream'),
          conversationId: target.current ?? undefined,
        });
        if (!still()) continue;
        if (!result.ok) failed = result.message || failed || '';
        setFiles((all) =>
          all.map((item) =>
            item.id !== file.id
              ? item
              : result.ok
                ? { ...item, status: 'done', remote: result.data }
                : { ...item, status: 'error' },
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
            kind: asset.mimeType?.startsWith('image/') ? 'image' : 'file',
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
                confirmLabel: t('common.openSettings'),
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
            mimeType: asset.mimeType || 'image/jpeg',
            size: asset.fileSize,
            status: 'uploading',
          }));
        }
        picked = picked.slice(0, MAX_FILES - current.current.length);
        if (!picked.length) return;
        // Everything picked shows at once, including the files waiting their turn to upload.
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
  return { files, setFiles, attach, remove, retry };
}
