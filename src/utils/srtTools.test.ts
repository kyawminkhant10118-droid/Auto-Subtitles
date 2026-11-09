import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSrtTime,
  parseSrtTime,
  cleanCorruptedMyanmarText,
  safeParseJsonArray,
  normalizeAndRepairCues,
  parseSrt,
  serializeSrt,
  shiftSrtTimestamps,
  calculateChunkPlan,
  chunkCuesForBatchTranslation,
} from './srtTools.ts';

test('formatSrtTime and parseSrtTime convert accurately to the millisecond', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000');
  assert.equal(formatSrtTime(65.432), '00:01:05,432');
  assert.equal(formatSrtTime(3723.09), '01:02:03,090');

  assert.equal(parseSrtTime('00:01:05,432'), 65.432);
  assert.equal(parseSrtTime('01:02:03.090'), 3723.09);
  assert.equal(parseSrtTime('12.5'), 12.5);
});

test('cleanCorruptedMyanmarText strips ud83cd, ud83cudf38, ufe0f, u200d, HTML entities, and emojis while preserving Burmese text', () => {
  const dirty =
    'မင်္ဂလာပါ ud83cd နေကောင်းလား ud83cudf38 \\ud83d\\ude00 အရမ်းလှတယ်ud83cdf38 u2764ufe0f u200d &quot;ဟုတ်ကဲ့&quot; 🌸✨';
  const result = cleanCorruptedMyanmarText(dirty);

  assert.ok(!result.cleaned.includes('ud83c'));
  assert.ok(!result.cleaned.includes('ud83cd'));
  assert.ok(!result.cleaned.includes('udf38'));
  assert.ok(!result.cleaned.includes('u2764'));
  assert.ok(!result.cleaned.includes('ufe0f'));
  assert.ok(!result.cleaned.includes('u200d'));
  assert.ok(!result.cleaned.includes('🌸'));
  assert.equal(result.cleaned, 'မင်္ဂလာပါ နေကောင်းလား အရမ်းလှတယ် "ဟုတ်ကဲ့"');
  assert.ok(result.removedCount >= 6);
});

test('safeParseJsonArray recovers valid objects even when LLM output is truncated mid-JSON', () => {
  const truncatedJson =
    '```json\n[{"id":1,"translatedText":"မင်္ဂလာပါ"},{"id":2,"translatedText":"နေကောင်းလားခင်ဗျာ"},{"id":3,"translatedText":"ဒီနေ့တော့ မိုးရွာ';
  const recovered = safeParseJsonArray<{ id: number; translatedText: string }>(truncatedJson);
  assert.equal(recovered.length, 2);
  assert.equal(recovered[0].id, 1);
  assert.equal(recovered[0].translatedText, 'မင်္ဂလာပါ');
  assert.equal(recovered[1].id, 2);
  assert.equal(recovered[1].translatedText, 'နေကောင်းလားခင်ဗျာ');
});

test('normalizeAndRepairCues fixes reversed timestamps and re-indexes sequentially', () => {
  const broken = [
    {
      id: 99,
      startSeconds: 10,
      endSeconds: 8, // reversed!
      startTime: '',
      endTime: '',
      originalText: 'Hello',
      translatedText: 'မင်္ဂလာပါ ud83cd',
    },
  ];
  const repaired = normalizeAndRepairCues(broken);
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].id, 1);
  assert.equal(repaired[0].startSeconds, 10);
  assert.equal(repaired[0].endSeconds, 10.4);
  assert.equal(repaired[0].translatedText, 'မင်္ဂလာပါ');
});

test('parseSrt and serializeSrt preserve sequence numbers and timestamps', () => {
  const sampleSrt = [
    '1',
    '00:00:01,200 --> 00:00:04,500',
    'ဒီနေ့ ရာသီဥတု သာယာပါတယ်။ ud83cd',
    '',
    '2',
    '00:00:05,000 --> 00:00:08,750',
    'အချိန်အတိအကျ စာတန်းထိုး ထုတ်ပေးပါတယ်။',
  ].join('\n');

  const cues = parseSrt(sampleSrt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startTime, '00:00:01,200');
  assert.equal(cues[0].endTime, '00:00:04,500');
  assert.equal(cues[0].translatedText, 'ဒီနေ့ ရာသီဥတု သာယာပါတယ်။');

  const output = serializeSrt(cues, 'myanmar');
  assert.ok(output.includes('00:00:01,200 --> 00:00:04,500'));
  assert.ok(!output.includes('ud83c'));
});

test('shiftSrtTimestamps offsets cues accurately and clamps at zero', () => {
  const cues = parseSrt('1\n00:00:01,000 --> 00:00:03,000\nမင်္ဂလာပါ');
  const shiftedForward = shiftSrtTimestamps(cues, 500);
  assert.equal(shiftedForward[0].startTime, '00:00:01,500');
  assert.equal(shiftedForward[0].endTime, '00:00:03,500');

  const shiftedBack = shiftSrtTimestamps(cues, -2000);
  assert.equal(shiftedBack[0].startTime, '00:00:00,000');
  assert.equal(shiftedBack[0].endTime, '00:00:02,000');
});

test('calculateChunkPlan slices a 450MB 35-minute video into compact 2-minute (~3.66MB) chunks', () => {
  const plan = calculateChunkPlan(450 * 1024 * 1024, 35 * 60, 120);
  assert.equal(plan.chunkCount, 18);
  assert.ok(plan.chunks[0].estimatedWavMB < 4.5);
  assert.equal(plan.chunks[0].startSeconds, 0);
  assert.equal(plan.chunks[0].endSeconds, 120);
  assert.equal(plan.chunks[1].startSeconds, 120);
  assert.equal(plan.chunks[1].endSeconds, 240);
});

test('chunkCuesForBatchTranslation splits large subtitle arrays into safe 20-cue batches', () => {
  const dummyCues = Array.from({ length: 65 }, (_, i) => ({
    id: i + 1,
    startSeconds: i * 2,
    endSeconds: i * 2 + 1.5,
    startTime: formatSrtTime(i * 2),
    endTime: formatSrtTime(i * 2 + 1.5),
    originalText: `Line ${i + 1}`,
    translatedText: `စာကြောင်း ${i + 1}`,
  }));

  const batches = chunkCuesForBatchTranslation(dummyCues, 20);
  assert.equal(batches.length, 4);
  assert.equal(batches[0].length, 20);
  assert.equal(batches[1].length, 20);
  assert.equal(batches[2].length, 20);
  assert.equal(batches[3].length, 5);
});
