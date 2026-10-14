/** Test support for upload routes. */

/**
 * A multipart upload sent as a stream, so no Content-Length says how big it is: `size` bytes of
 * file, made as they are read.
 */
export function streamedUpload(size: number) {
  const boundary = 'gh-boundary';
  const encode = (text: string) => new TextEncoder().encode(text);
  const head = encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = encode(`\r\n--${boundary}--\r\n`);
  const chunk = new Uint8Array(1024 * 1024);
  let sent = -1;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < 0) {
        controller.enqueue(head);
        sent = 0;
      } else if (sent < size) {
        const length = Math.min(chunk.length, size - sent);
        controller.enqueue(length === chunk.length ? chunk : chunk.subarray(0, length));
        sent += length;
      } else {
        controller.enqueue(tail);
        controller.close();
      }
    },
  });
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}
