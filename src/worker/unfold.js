const boxSchema = { type: 'object', additionalProperties: false, properties: {
  left: { type: 'number' }, top: { type: 'number' }, right: { type: 'number' }, bottom: { type: 'number' }
}, required: ['left', 'top', 'right', 'bottom'] };
const measureSchema = { type: 'object', additionalProperties: false, properties: {
  number: { type: 'integer' }, box: boxSchema, ending: { type: 'array', items: { type: 'integer' } },
  repeatStart: { type: 'boolean' }, repeatEnd: { type: 'boolean' }, segno: { type: 'boolean' }, coda: { type: 'boolean' },
  toCoda: { type: 'boolean' }, fine: { type: 'boolean' }, jump: { type: 'string', enum: ['none', 'dc', 'ds'] },
  jumpTarget: { type: 'string', enum: ['end', 'fine', 'coda'] }
}, required: ['number', 'box', 'ending', 'repeatStart', 'repeatEnd', 'segno', 'coda', 'toCoda', 'fine', 'jump', 'jumpTarget'] };
const schema = { type: 'object', additionalProperties: false, properties: { measures: { type: 'array', items: measureSchema } }, required: ['measures'] };

class UnfoldProblem extends Error { constructor(message, status = 422) { super(message); this.status = status; } }
function check(value, message) { if (!value) throw new UnfoldProblem(message); }
function base64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}
function validatePage(reading, page) {
  check(Array.isArray(reading?.measures) && reading.measures.length > 0, `${page}페이지에서 마디 위치를 찾지 못했습니다.`);
  for (const bar of reading.measures) {
    const box = bar?.box;
    check(Number.isInteger(bar?.number) && bar.number > 0, `${page}페이지의 마디 번호를 확인할 수 없습니다.`);
    check(box && [box.left, box.top, box.right, box.bottom].every(Number.isFinite)
      && box.left >= 0 && box.top >= 0 && box.right <= 1000 && box.bottom <= 1000
      && box.right - box.left >= 8 && box.bottom - box.top >= 20, `${page}페이지 ${bar.number}마디의 영역을 확인할 수 없습니다.`);
    check(Array.isArray(bar.ending) && bar.ending.every(number => number === 1 || number === 2)
      && ['repeatStart', 'repeatEnd', 'segno', 'coda', 'toCoda', 'fine'].every(name => typeof bar[name] === 'boolean')
      && ['none', 'dc', 'ds'].includes(bar.jump) && ['end', 'fine', 'coda'].includes(bar.jumpTarget), `${page}페이지 ${bar.number}마디의 반복·이동 표식을 확인할 수 없습니다.`);
  }
  for (let index = 1; index < reading.measures.length; index++) {
    const before = reading.measures[index - 1], after = reading.measures[index];
    check(after.number === before.number + 1, `${page}페이지의 마디 번호가 이어지지 않습니다.`);
    const a = before.box, b = after.box;
    const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const smaller = Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top));
    check(overlap / smaller < .3, `${page}페이지 ${before.number}·${after.number}마디의 영역이 겹칩니다.`);
  }
  return reading.measures;
}
function orderOf(bars) {
  const segno = bars.findIndex(bar => bar.segno), coda = bars.findIndex(bar => bar.coda);
  const jumpBar = bars.find(bar => bar.jump !== 'none');
  const order = [], repeated = new Set(), seen = new Set();
  let index = 0, repeatStart = 0, repeatPass = 1, jumped = false, codaTaken = false;
  while (index < bars.length) {
    check(order.length < 500, '반복 구간이 너무 길거나 끝나지 않습니다.');
    const state = `${index}:${repeatStart}:${repeatPass}:${[...repeated].join(',')}:${jumped}:${codaTaken}`;
    check(!seen.has(state), '악보의 이동 지시가 순환합니다.');
    seen.add(state);
    const bar = bars[index];
    if (!jumped && bar.repeatStart && index !== repeatStart) { repeatStart = index; repeatPass = 1; }
    if (bar.ending.length && !bar.ending.includes(repeatPass)) { index++; continue; }
    order.push(index);
    if (jumped && jumpBar?.jumpTarget === 'fine' && bar.fine) break;
    if (jumped && jumpBar?.jumpTarget === 'coda' && bar.toCoda && !codaTaken) { check(coda > index, '코다 위치가 To Coda보다 앞에 있습니다.'); index = coda; codaTaken = true; continue; }
    if (!jumped && bar.repeatEnd && !repeated.has(index)) { repeated.add(index); repeatPass = 2; index = repeatStart; continue; }
    if (!jumped && bar.jump !== 'none') { jumped = true; repeatPass = 2; index = bar.jump === 'dc' ? 0 : segno; continue; }
    index++;
  }
  check(!jumpBar || jumped, 'D.S./D.C. 위치에 도달하지 못했습니다.');
  check(!jumpBar || jumpBar.jumpTarget !== 'coda' || codaTaken, 'To Coda 위치를 찾지 못했습니다.');
  check(!jumpBar || jumpBar.jumpTarget !== 'fine' || bars[order.at(-1)]?.fine, 'Fine 위치를 찾지 못했습니다.');
  return order;
}

export async function unfoldPdf(bytes, askAI, PDFDocument) {
  let source;
  try { source = await PDFDocument.load(bytes); } catch { throw new UnfoldProblem('PDF 악보를 읽을 수 없습니다.', 415); }
  const pageCount = source.getPageCount();
  check(pageCount >= 1 && pageCount <= 12, 'PDF는 최대 12페이지까지 판독할 수 있습니다.');
  const measures = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const page = source.getPage(pageIndex);
    check(page.getRotation().angle % 360 === 0, `${pageIndex + 1}페이지가 회전되어 있습니다. 회전을 해제해 주세요.`);
    const single = await PDFDocument.create();
    single.addPage((await single.copyPages(source, [pageIndex]))[0]);
    const data = base64(await single.save());
    let reading, error;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        reading = validatePage(await askAI({ model: 'gpt-5.6-sol', reasoning: { effort: 'xhigh' }, max_output_tokens: 12000,
          instructions: 'Locate every written measure on this single PDF score page. Do not transcribe pitches or notes. For each measure return its absolute written measure number, a tight rectangular crop containing all staves, clefs, signatures, barlines and notes, plus repeat/navigation markers. Coordinates are 0..1000 relative to the displayed page, origin top left. Neighboring measures in the same system must not overlap appreciably. Identify first/second endings, repeat starts and ends, D.S./D.C., segno, coda, To Coda and Fine precisely. If positions or navigation are uncertain, do not invent measures.',
          input: [{ role: 'user', content: [{ type: 'input_file', filename: `score-page-${pageIndex + 1}.pdf`, file_data: `data:application/pdf;base64,${data}`, detail: 'high' },
            { type: 'input_text', text: `Locate all written measures on page ${pageIndex + 1} of ${pageCount}, in order. Return absolute measure numbers.` }] }],
          text: { format: { type: 'json_schema', name: 'score_crop_layout', strict: true, schema } } }), pageIndex + 1);
        break;
      } catch (failure) { error = failure; }
    }
    if (!reading) throw new UnfoldProblem(`${pageIndex + 1}페이지의 마디 위치를 확인하지 못했습니다: ${error?.message || '판독 실패'}`);
    for (const bar of reading) {
      check(bar.number === measures.length + 1, `${pageIndex + 1}페이지에서 ${measures.length + 1}마디가 누락되거나 중복되었습니다.`);
      measures.push({ ...bar, page: pageIndex });
    }
    check(measures.length <= 160, '펼친 악보는 최대 160마디까지 지원합니다.');
  }
  check(measures.filter(bar => bar.segno).length <= 1 && measures.filter(bar => bar.coda).length <= 1
    && measures.filter(bar => bar.jump !== 'none').length <= 1, '여러 개의 세뇨·코다·D.S./D.C.는 자동으로 확정할 수 없습니다.');
  const jump = measures.find(bar => bar.jump !== 'none');
  check(!jump || jump.jump !== 'ds' || measures.some(bar => bar.segno), 'D.S.의 세뇨 위치를 찾지 못했습니다.');
  check(!jump || jump.jumpTarget !== 'coda' || measures.some(bar => bar.coda), '코다 위치를 찾지 못했습니다.');
  const order = orderOf(measures);
  const output = await PDFDocument.create();
  const size = [595.28, 841.89], margin = 24, gap = 5, rowGap = 15;
  const boxes = measures.map(bar => {
    const { width, height } = source.getPage(bar.page).getSize();
    return { left: bar.box.left * width / 1000, right: bar.box.right * width / 1000,
      bottom: height * (1 - bar.box.bottom / 1000), top: height * (1 - bar.box.top / 1000) };
  });
  const scale = Math.min(1, 130 / Math.max(...boxes.map(box => box.top - box.bottom)),
    (size[0] - margin * 2) / Math.max(...boxes.map(box => box.right - box.left)));
  const embedded = new Map();
  let page = output.addPage(size), top = size[1] - margin, x = margin, rowHeight = 0;
  for (const index of order) {
    const bar = measures[index], box = boxes[index];
    const width = (box.right - box.left) * scale, height = (box.top - box.bottom) * scale;
    if (x > margin && x + width > size[0] - margin + .01) { top -= rowHeight + rowGap; x = margin; rowHeight = 0; }
    if (top - height < margin) { check(output.getPageCount() < 80, '펼친 악보 PDF 페이지 수가 너무 많습니다.'); page = output.addPage(size); top = size[1] - margin; x = margin; rowHeight = 0; }
    if (!embedded.has(index)) embedded.set(index, await output.embedPage(source.getPage(bar.page), box));
    page.drawPage(embedded.get(index), { x, y: top - height, width, height });
    x += width + gap;
    rowHeight = Math.max(rowHeight, height);
  }
  return { pdf: await output.save(), sourceMeasures: measures.length, outputMeasures: order.length };
}
