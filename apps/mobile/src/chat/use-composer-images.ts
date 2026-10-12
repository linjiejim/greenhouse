/** Camera/library attachments for both chat composers. Upload once, retry in place. */
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { prepareImage, uploadImage } from '../api/upload';
import { t } from '../lib/i18n';
import { alertError, confirmAction } from '../ui/dialogs';
import { recoverDraftImages, type ComposerImage } from './composer-images';

let seq = 0;

export function useComposerImages(maxImages: number, initial: ComposerImage[] = []) {
  const [images, updateImages] = useState(() => recoverDraftImages(initial));
  const current = useRef(images);
  const mounted = useRef(true);
  const picking = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Synchronous claim: a second tap cannot start the same retry or overfill the draft.
  const setImages = useCallback((next: SetStateAction<ComposerImage[]>) => {
    current.current = typeof next === 'function' ? next(current.current) : next;
    updateImages(current.current);
  }, []);

  const upload = useCallback(
    async (picked: ComposerImage[]) => {
      let failed = false;
      for (const image of picked) {
        if (!mounted.current || !current.current.some((im) => im.id === image.id)) continue;
        const uri = await prepareImage(image.uri, image.width);
        if (!mounted.current || !current.current.some((im) => im.id === image.id)) continue;
        const result = await uploadImage(uri, uri === image.uri ? image.mimeType : 'image/jpeg');
        if (!mounted.current) return;
        if (!current.current.some((im) => im.id === image.id)) continue;
        if (!result) failed = true;
        setImages((all) =>
          all.map((im) =>
            im.id !== image.id
              ? im
              : result
                ? { ...im, status: 'done', remote: { id: result.id, url: result.url } }
                : { ...im, status: 'error' },
          ),
        );
      }
      if (mounted.current && failed) alertError(t('upload.failed'));
    },
    [setImages],
  );

  const retryImages = useCallback(() => {
    const failed = current.current.filter((image) => image.status === 'error');
    if (!failed.length) return;
    setImages((all) => all.map((image) => (image.status === 'error' ? { ...image, status: 'uploading' } : image)));
    void upload(failed);
  }, [setImages, upload]);

  const attach = useCallback(
    async (from: 'camera' | 'library') => {
      if (picking.current) return;
      const room = maxImages - current.current.length;
      if (room <= 0) {
        alertError(t('chat.maxImages', { n: maxImages }));
        return;
      }
      picking.current = true;
      try {
        if (from === 'camera') {
          const permission = await ImagePicker.requestCameraPermissionsAsync();
          if (!permission.granted) {
            const go = await confirmAction({
              title: t('chat.cameraDenied'),
              message: t('chat.cameraDeniedHint'),
              confirmLabel: t('chat.openSettings'),
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
        const picked: ComposerImage[] = result.assets.slice(0, maxImages - current.current.length).map((asset) => ({
          id: `image-${Date.now().toString(36)}-${++seq}`,
          uri: asset.uri,
          width: asset.width,
          mimeType: asset.mimeType || 'image/jpeg',
          status: 'uploading',
        }));
        // All selected images appear immediately, including those waiting their turn to upload.
        setImages((all) => [...all, ...picked]);
        void upload(picked);
      } catch {
        if (mounted.current) alertError(t('upload.failed'));
      } finally {
        picking.current = false;
      }
    },
    [maxImages, setImages, upload],
  );

  const removeImage = useCallback((id: string) => setImages((all) => all.filter((im) => im.id !== id)), [setImages]);
  return { images, setImages, attach, removeImage, retryImages };
}
