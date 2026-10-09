/** add-multimodal-input 测试：blocks.ts 双分支形态 / kimi URL 占位 / 纯文本投影 /
 * deepseek-flash 限制校验 / 格式白名单 / offloaded 占位 / 无图像零回归。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectImagesForTextModel,
  textOnlyImageText,
  offloadedImageText,
  type ContentBlock,
  type GenerateOptions,
  type ImageBlock,
} from '@deepseek-ai/dsh-llm';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { prepareImages, translateUserContent, type ImageAccessResolver } from '../src/wire/blocks.ts';
import { buildChatBody } from '../src/wire/body-chat.ts';
import { buildResponsesBody } from '../src/wire/body-responses.ts';

const MODEL = 'sensenova-6.8-flash-lite'; // imageFormats jpg/jpeg/png/webp，无 base64 限制
const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-sn-blocks-'));
const pngPath = join(tmpDir, 'a.png');
writeFileSync(pngPath, Buffer.from('89504e470d0a1a0a', 'hex')); // 8 字节 PNG 头

type ImageRef = ImageBlock['attachment'];

function ref(mediaType = 'image/png', id = 'sha256:aa'): ImageRef {
  return {
    attachmentId: id,
    name: 'a.png',
    width: 4,
    height: 4,
    mediaType,
  } as ImageRef;
}

function imageBlock(r: ImageRef, offloaded?: true): ContentBlock {
  return { type: 'image', attachment: r, ...(offloaded ? { offloaded } : {}) } as ContentBlock;
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

function opts(model: string, messages: GenerateOptions['messages']): GenerateOptions {
  return { provider: 'sensenova', model, messages };
}

const localFile: ImageAccessResolver = (r) => ({
  readonlyPath: pngPath,
  ...(typeof r.mediaType === 'string' && r.mediaType === 'image/bmp' ? {} : {}),
});

test.after(() => rmSync(tmpDir, { recursive: true, force: true }));

// ---- 1. 双分支形态（chat 嵌套 / responses 扁平，1.1/2.1）----

test('chat：文本+图像 → content 数组，image_url 嵌套形态 + data URL', async () => {
  const options = opts(MODEL, [{ role: 'user', content: [textBlock('看图'), imageBlock(ref())] }]);
  const images = await prepareImages(options, undefined, 'chat-completions', localFile);
  const body = buildChatBody(options, undefined, images);
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(Array.isArray(last.content));
  const items = last.content as Array<Record<string, unknown>>;
  assert.deepEqual(items[0], { type: 'text', text: '看图' });
  assert.equal(items[1].type, 'image_url');
  assert.deepEqual(items[1].image_url, { url: `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}` });
});

test('responses：文本+图像 → input_image 扁平字段（image_url 为字符串）', async () => {
  const options = opts(MODEL, [{ role: 'user', content: [textBlock('看图'), imageBlock(ref())] }]);
  const images = await prepareImages(options, undefined, 'responses', localFile);
  const body = buildResponsesBody(options, undefined, {}, images);
  const input = body.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  const items = input[input.length - 1].content;
  assert.deepEqual(items[0], { type: 'input_text', text: '看图' });
  assert.equal(items[1].type, 'input_image');
  assert.equal(typeof items[1].image_url, 'string');
  assert.ok((items[1].image_url as string).startsWith('data:image/png;base64,'));
});

// ---- 2. kimi-k3：仅 base64，公网 URL → 文本占位（design 决策 3）----

test('kimi-k3：URL 来源不进载荷，出站为文本占位（无 image 项）', async () => {
  const options = opts('kimi-k3', [{ role: 'user', content: [textBlock('q'), imageBlock(ref())] }]);
  const images = await prepareImages(options, undefined, 'chat-completions', () => ({ url: 'https://cdn.example.com/a.png' }));
  assert.equal(images.size, 0); // 占位路径
  const content = translateUserContent(options.messages[0]!.content, 'chat-completions', images);
  assert.ok(Array.isArray(content));
  const items = content as Array<Record<string, unknown>>;
  assert.ok(items.every((item) => item.type === 'text')); // 无 image_url 项
  assert.equal(items[1]!.text, textOnlyImageText(ref())); // 宿主占位文本原样
});

// ---- 3. 纯文本模型投影（2.2：v4-flash/glm 复用宿主投影，不自造）----

test('纯文本模型：projectImagesForTextModel 投影后出站回到纯字符串', () => {
  const messages = [{ role: 'user', content: [textBlock('q'), imageBlock(ref())] }] as GenerateOptions['messages'];
  const projected = projectImagesForTextModel(messages);
  const options = opts('deepseek-v4-flash', [...projected]);
  const body = buildChatBody(options, undefined, undefined);
  const messages0 = body.messages as Array<{ role: string; content: unknown }>;
  const last = messages0[messages0.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(typeof last.content, 'string');
  assert.ok((last.content as string).includes(textOnlyImageText(ref())));
});

// ---- 4. deepseek-flash 限制校验（3.1：50MB / 64MB / 200 张）----

function flashOpts(count: number): GenerateOptions {
  const blocks: ContentBlock[] = [textBlock('q')];
  for (let i = 0; i < count; i += 1) blocks.push(imageBlock(ref('image/png', `sha256:${i}`)));
  return opts('deepseek-flash', [{ role: 'user', content: blocks }]);
}

test('deepseek-flash：单图 > 50MB → 报错文案含 50 MB 与实际值', async () => {
  const oversized: ImageAccessResolver = () => ({ readonlyPath: pngPath, byteLength: 50 * 1024 * 1024 + 1 });
  await assert.rejects(
    () => prepareImages(flashOpts(1), undefined, 'chat-completions', oversized),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.match(error.message, /50 MB/);
      assert.match(error.message, /50\.0 MB/);
      return true;
    },
  );
});

test('deepseek-flash：总量 > 64MB → 报错（两张 33MB）', async () => {
  const chunk: ImageAccessResolver = () => ({ readonlyPath: pngPath, byteLength: 33 * 1024 * 1024 });
  await assert.rejects(
    () => prepareImages(flashOpts(2), undefined, 'chat-completions', chunk),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.match(error.message, /64 MB/);
      return true;
    },
  );
});

test('deepseek-flash：201 张 → 报错文案含 200', async () => {
  await assert.rejects(
    () => prepareImages(flashOpts(201), undefined, 'chat-completions', () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.match(error.message, /200/);
      return true;
    },
  );
});

test('deepseek-flash：合法小图两张通过且 URL 来源照传', async () => {
  const images = await prepareImages(flashOpts(2), undefined, 'chat-completions', () => ({ url: 'https://x/y.png' }));
  assert.equal(images.size, 2);
});

// ---- 5. 格式白名单（2.3：不支持格式报错含支持列表；Responses 再求交）----

test('6.8：bmp 不支持 → 报错文案含格式与支持列表', async () => {
  const options = opts(MODEL, [{ role: 'user', content: [imageBlock(ref('image/bmp'))] }]);
  await assert.rejects(
    () => prepareImages(options, undefined, 'chat-completions', localFile),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.match(error.message, /image\/bmp/);
      assert.match(error.message, /jpeg/);
      assert.match(error.message, /png/);
      return true;
    },
  );
});

test('kimi responses wire：bmp 与协议集求交后仍不支持（Responses 协议标注）', async () => {
  const options = opts('kimi-k3', [{ role: 'user', content: [imageBlock(ref('image/bmp'))] }]);
  await assert.rejects(
    () => prepareImages(options, undefined, 'responses', localFile),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.match(error.message, /Responses 协议/);
      return true;
    },
  );
});

// ---- 6. offloaded 块与去重（1.2 边界）----

test('offloaded 图像 → 宿主 offloadedImageText 文本项，不进图像路径', async () => {
  const content = [textBlock('q'), imageBlock(ref(), true)];
  const images = await prepareImages(opts(MODEL, [{ role: 'user', content }]), undefined, 'chat-completions', localFile);
  assert.equal(images.size, 0);
  const translated = translateUserContent(content, 'chat-completions', images) as Array<Record<string, unknown>>;
  assert.equal(translated[1]!.type, 'text');
  assert.equal(translated[1]!.text, offloadedImageText(ref()));
});

test('同一 attachmentId 出现两次只编码一次', async () => {
  const r = ref();
  const options = opts(MODEL, [
    { role: 'user', content: [textBlock('a'), imageBlock(r)] },
    { role: 'user', content: [textBlock('b'), imageBlock(r)] },
  ]);
  const images = await prepareImages(options, undefined, 'chat-completions', localFile);
  assert.equal(images.size, 1);
});

// ---- 7. 无图像零回归（1.3：纯文本保持迁移前出站）----

test('无图像：content 仍为纯字符串（chat 与 responses 同）', async () => {
  const options = opts(MODEL, [{ role: 'user', content: [textBlock('你好'), textBlock('世界')] }]);
  const images = await prepareImages(options, undefined, 'chat-completions', localFile);
  assert.equal(images.size, 0);
  assert.equal(translateUserContent(options.messages[0]!.content, 'chat-completions', images), '你好世界');
  const chatBody = buildChatBody(options, undefined, images);
  const chatMessages = chatBody.messages as Array<{ role: string; content: unknown }>;
  assert.equal(chatMessages[chatMessages.length - 1]!.content, '你好世界');
  const responsesBody = buildResponsesBody(options, undefined, {}, images);
  const input = responsesBody.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.deepEqual(input[input.length - 1]!.content, [{ type: 'input_text', text: '你好世界' }]);
});
