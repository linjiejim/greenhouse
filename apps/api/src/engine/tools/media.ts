import { defineTool } from './define.js';
import { imageInput, videoInput, type MediaService } from '../../modules/media/service.js';

export function mediaTools(media: MediaService) {
  return [
    defineTool({
      name: 'generate_image',
      description:
        'Generate an image, or edit a reference_file_id the member can read. Supply a prompt; the result appears as an artifact card with preview and download. File ids are internal: do not repeat them or attachment markers in the reply.',
      input: imageInput,
      risk: 'read',
      surfaces: ['turn'],
      outbound: true,
      available: (ctx) => ctx.available('image'),
      execute: (input, ctx) => media.image(ctx, input),
      summarize: (_input, _output, locale) => (locale === 'zh' ? '生成了图片' : 'Generated an image'),
    }),
    defineTool({
      name: 'generate_video',
      description:
        'Propose an asynchronous video render. The member must approve the exact prompt and duration; then progress appears in Runs and the artifact reports here. Never claim the video is ready before the completion report.',
      input: videoInput,
      risk: 'external',
      surfaces: ['turn'],
      outbound: true,
      available: (ctx) => ctx.available('video'),
      describe: (input, ctx) => ({
        summary: ctx.locale === 'zh' ? '生成视频' : 'Generate video',
        details: [
          { label: ctx.locale === 'zh' ? '提示词' : 'Prompt', value: input.prompt },
          { label: ctx.locale === 'zh' ? '时长' : 'Duration', value: `${input.seconds}s` },
        ],
      }),
      execute: (input, ctx) => media.video(ctx, input),
      summarize: (_input, _output, locale) => (locale === 'zh' ? '视频已排队' : 'Video queued'),
    }),
  ];
}
