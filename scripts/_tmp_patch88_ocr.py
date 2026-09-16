# -*- coding: utf-8 -*-
"""round88 #130：OCR 失败必须可诊断（四态标注 + 失败不写缓存 + auto 兜底不白送）。"""
P = 'src/services/image-analysis.js'
data = open(P, 'rb').read()
assert data.count(b'\r\n') == data.count(b'\n'), '应为纯 CRLF'
src = data.decode('utf-8')
NL = '\r\n'
L = lambda *ls: NL.join(ls)

# ---------- 1) 新增 explainOcrFailure（纯函数，插在 enrichForLlm 之前） ----------
anchor = 'export async function enrichForLlm(messages, opts = {}) {'
assert src.count(anchor) == 1, '锚点0 %d' % src.count(anchor)

fn = L(
    '/**',
    ' * 把 OCR 抛出的错误翻成「人能看懂 + 能自救」的一句话（round88）。',
    ' *',
    ' * 为什么必须有它：OCR 循环里原先是 `catch { text = \'\' }` —— 云端密钥失效 / 端点写错 /',
    ' * 本地语言包下载失败 / 单张超时 / 用户取消，全部被压成同一句「未能识别文字，未纳入分析」。',
    ' * 用户拿到这句话无法行动：明明是密钥过期，他却在反复重传图片、反复重试同一件错事。',
    ' * 与 base.js 的 explainLlmFailure 是同一套思路（那个也是把「网络或服务异常」改细的）。',
    ' *',
    ' * @param {*} e OCR 抛出的错误（可能根本不是 Error）',
    ' * @returns {{kind:string, text:string}} kind 供程序分支；text 是写给用户/模型看的原因',
    ' */',
    'export function explainOcrFailure(e) {',
    "  const msg = String(e?.message || e || '');",
    "  if (e?.name === 'AbortError' || /\\baborted\\b|已取消/i.test(msg)) {",
    "    return { kind: 'timeout', text: '单张识别超时（30 秒）或被取消' };",
    '  }',
    '  const m = msg.match(/云端 OCR 失败 HTTP (\\d{3})/);',
    '  if (m) {',
    '    const s = Number(m[1]);',
    "    if (s === 401 || s === 403) return { kind: 'auth', text: '云端 OCR 的密钥无效或无权限' };",
    "    if (s === 404) return { kind: 'cloud', text: '云端 OCR 的端点地址不对（HTTP 404）' };",
    "    if (s === 429) return { kind: 'cloud', text: '云端 OCR 被限流（HTTP 429）' };",
    "    if (s >= 500) return { kind: 'server', text: '云端 OCR 服务端出错（5xx）' };",
    "    return { kind: 'cloud', text: `云端 OCR 被拒绝（HTTP ${s}）` };",
    '  }',
    '  if (/Failed to fetch|NetworkError|ECONNREFUSED|ENOTFOUND|网络/i.test(msg)) {',
    "    return { kind: 'network', text: '云端 OCR 连不上（网络不可达，或端点地址写错）' };",
    '  }',
    '  if (/lang|traineddata|tesseract|wasm|worker/i.test(msg)) {',
    "    return { kind: 'assets', text: '本地识别引擎或语言包加载失败（离线环境常缺语言包）' };",
    '  }',
    "  if (!msg) return { kind: 'unknown', text: '识别出错（未给出具体原因）' };",
    "  return { kind: 'unknown', text: `识别出错（${msg.slice(0, 120)}）` };",
    '}',
    '',
)
src = src.replace(anchor, fn + anchor, 1)

# ---------- 2) 循环：记录失败原因 / 取消 / 失败不写缓存 ----------
old1 = L(
    '    const missingOcr = new Set();',
    '    for (const id of ocrIds) {',
    '      if (ocrSignal?.aborted) break;',
)
new1 = L(
    '    const missingOcr = new Set();',
    '    const canceledOcr = new Set();  // 信号已中止 → 压根没跑识别（与「识别失败」不同：重试即可）',
    '    const ocrError = new Map();     // id → 识别失败的原因（人话，来自 explainOcrFailure）',
    '    for (const id of ocrIds) {',
    '      // 旧实现这里直接 break，剩余图就没有标注、会被归到「未能识别」；',
    '      // 改成逐张标「已取消」——用户取消后重试即可，不需要去改任何配置。',
    '      if (ocrSignal?.aborted) { canceledOcr.add(id); continue; }',
)
assert src.count(old1) == 1, '锚点1 %d' % src.count(old1)
src = src.replace(old1, new1, 1)

old2 = L(
    '        } catch {',
    "          text = ''; // 识别失败：留空，由下方 visionRefs 兜底或标注「未能识别」",
    '        }',
    '      }',
    '      setOcr(id, text, sig);',
    '      ocrText[id] = text;',
)
new2 = L(
    '        } catch (e) {',
    "          text = '';",
    '          // round88：不再静默留空。把真实原因留下来，下面的标注才能说清「该去改哪里」',
    '          // （密钥失效 / 端点写错 / 语言包缺失 / 超时，四件事的做法完全不同）。',
    '          ocrError.set(id, explainOcrFailure(e).text);',
    '        }',
    '      }',
    '      // round88：失败与取消**绝不写缓存**。旧实现连失败也 setOcr —— 网络抖一下，',
    '      // 这张图在整个会话里就永久「未能识别」，用户重试多少次都拿不到结果。',
    '      // 「跑通了但没识别出文字」是稳定结果，照常缓存（省下重复识别的开销）。',
    '      if (row && !ocrError.has(id)) setOcr(id, text, sig);',
    '      ocrText[id] = text;',
)
assert src.count(old2) == 1, '锚点2 %d' % src.count(old2)
src = src.replace(old2, new2, 1)

# ---------- 3) 四态标注 ----------
old3 = L(
    '    ids.forEach((id) => {',
    '      const ocr = ocrText[id];',
    '      textMap.set(`sxy-img://${id}`, ocr && ocr.trim()',
    '        ? `【图片(${id}) 内文字（OCR）】\\n${ocr.trim()}`',
    '        : (missingOcr.has(id)',
    '          // 行都不存在 → 与「OCR 没认出来」完全是两回事，分开说',
    '          ? `【图片(${id})：本机图库里没有这张图（多因尚未同步到本设备，或原图已被删除），`',
    "            + '无法识别；请在其他设备上同步一次，或重新上传该图】'",
    '          : `【图片(${id})】未能识别文字，未纳入分析`));',
    '    });',
)
new3 = L(
    '    // 下一步指引：ocrFirst 从不发送原图，必须明确告诉用户去哪里改；',
    '    // auto 已有视觉兜底，指引偏向「检查 OCR 配置 / 直接改先多模态」。',
    '    const ocrNextStep = policy.mode === \'ocrFirst\'',
    '      ? \'当前「图片分析策略」是「先 OCR」（该模式从不发送原图）；若想让 AI 直接看图，请到「设置 → 图片分析策略」改为「先多模态」。\'',
    '      : \'可到「设置 → OCR」检查云端端点 / 密钥与识别语言，或把「图片分析策略」改为「先多模态」让 AI 直接看图。\';',
    '    ids.forEach((id) => {',
    '      const ocr = ocrText[id];',
    '      const failWhy = ocrError.get(id);',
    '      if (ocr && ocr.trim()) {',
    '        textMap.set(`sxy-img://${id}`, `【图片(${id}) 内文字（OCR）】\\n${ocr.trim()}`);',
    '        return;',
    '      }',
    '      if (missingOcr.has(id)) {',
    '        // 行都不存在 → 与「OCR 没认出来」完全是两回事，分开说',
    '        textMap.set(`sxy-img://${id}`, `【图片(${id})：本机图库里没有这张图（多因尚未同步到本设备，或原图已被删除），`',
    "          + '无法识别；请在其他设备上同步一次，或重新上传该图】');",
    '        return;',
    '      }',
    '      if (canceledOcr.has(id)) {',
    '        textMap.set(`sxy-img://${id}`, `【图片(${id})：本次识别已取消（用户中止），未纳入分析；重新提问即可再试，不需要改任何设置】`);',
    '        return;',
    '      }',
    '      if (failWhy) {',
    '        textMap.set(`sxy-img://${id}`, `【图片(${id})：OCR 识别失败（${failWhy}），未纳入分析。${ocrNextStep}】`);',
    '        return;',
    '      }',
    '      // 跑通了但一个字都没识别出来 —— 与「识别报错」是两回事，别把用户引去查 OCR 配置',
    '      textMap.set(`sxy-img://${id}`, `【图片(${id})：OCR 没有识别出文字（图可能过暗 / 过糊，或图里本来就没有文字，`',
    '        + `也可能是识别语言不匹配），未纳入分析。${ocrNextStep}】`);',
    '    });',
)
assert src.count(old3) == 1, '锚点3 %d' % src.count(old3)
src = src.replace(old3, new3, 1)

# ---------- 4) auto 兜底：missing / 取消 的图不白送 ----------
old4 = L(
    "      const failed = ocrIds.filter((id) => !ocrText[id] || !ocrText[id].trim());",
)
new4 = L(
    '      const failed = ocrIds.filter((id) => {',
    '        // 图都没了 / 已取消 → 送也送不出去，别再白读一次库（旧实现会把它们一起塞进尝试列表）',
    '        if (missingOcr.has(id) || canceledOcr.has(id)) return false;',
    '        return !ocrText[id] || !ocrText[id].trim();',
    '      });',
)
assert src.count(old4) == 1, '锚点4 %d' % src.count(old4)
src = src.replace(old4, new4, 1)

# ---------- 5) 兜底成功标注：带上真实原因 ----------
old5 = L(
    '      for (const { id } of mapped) {',
    '        textMap.set(`sxy-img://${id}`, `【图片(${id})：OCR 未能识别，已作为附图发送给多模态模型】`);',
    '      }',
)
new5 = L(
    '      for (const { id } of mapped) {',
    '        const why = ocrError.get(id);',
    '        textMap.set(`sxy-img://${id}`, why',
    '          ? `【图片(${id})：OCR 识别失败（${why}），已改为把原图作为附图发送给多模态模型】`',
    '          : `【图片(${id})：OCR 未能识别，已作为附图发送给多模态模型】`);',
    '      }',
)
assert src.count(old5) == 1, '锚点5 %d' % src.count(old5)
src = src.replace(old5, new5, 1)

open(P, 'wb').write(src.encode('utf-8'))
print('ok, lines =', src.count(NL))
