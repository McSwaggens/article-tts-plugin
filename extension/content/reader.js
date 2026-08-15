"use strict";

/* Injected on demand (after Readability.js). Extracts the article, splits it
   into sentences with live-DOM Ranges, and drives highlight + autoscroll.

   Readability parses a CLONE of the document, so its output points at nothing
   live. Strategy: stamp candidate blocks in the live DOM first (the stamps
   survive cloneNode), run Readability on the clone, keep the live blocks whose
   stamps survive in its output, and extract sentence text/Ranges from those
   live elements. Text-matching fallback covers Readability stripping the
   stamp attributes.
*/

(() => {
  if (window.__ttsInjected) return;
  window.__ttsInjected = true;

  const BLOCKS = "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dd,dt,td,pre";
  const MAX_CHUNK = 350; // chars per TTS request; long sentences are sub-chunked
  const norm = s => s.replace(/\s+/g, " ").trim();

  let sentenceRanges = []; // sentence index -> live Range

  const port = browser.runtime.connect({ name: "tts-content" });
  port.onDisconnect.addListener(() => {
    // Background went away (extension reload). Allow a future re-injection.
    window.__ttsInjected = false;
    clearHighlight();
  });

  port.onMessage.addListener(msg => {
    switch (msg.type) {
      case "EXTRACT_ARTICLE":
        try {
          port.postMessage({ type: "EXTRACT_RESULT", ...extract() });
        } catch (e) {
          port.postMessage({ type: "EXTRACT_RESULT", ok: false, reason: "empty" });
        }
        break;
      case "HIGHLIGHT":
        highlight(msg.i);
        break;
      case "CLEAR_HIGHLIGHT":
        clearHighlight();
        break;
    }
  });

  function allBlocks(root) {
    // Containers and their nested blocks both appear (document order). Each
    // block only contributes its DIRECT text (sentencesForBlock rejects text
    // living inside a nested block), so nothing is read twice and a
    // <li>summary <p>details</p></li> loses neither part.
    return [...root.querySelectorAll(BLOCKS)];
  }

  function findArticleBlocks() {
    if (!isProbablyReaderable(document)) return { ok: false, reason: "not-readerable" };

    const liveBlocks = allBlocks(document);
    liveBlocks.forEach((el, i) => el.setAttribute("data-tts-b", String(i)));
    let article = null;
    try {
      article = new Readability(document.cloneNode(true)).parse();
    } catch {}
    if (!article || !article.content) {
      liveBlocks.forEach(el => el.removeAttribute("data-tts-b"));
      return { ok: false, reason: "empty" };
    }

    const holder = document.createElement("div"); // detached, never inserted
    holder.innerHTML = article.content;

    let blocks = [...holder.querySelectorAll("[data-tts-b]")]
      .map(e => liveBlocks[+e.getAttribute("data-tts-b")])
      .filter(Boolean);

    if (blocks.length === 0) {
      // Fallback: greedy in-order matching on normalized text.
      const wanted = allBlocks(holder).map(e => norm(e.textContent)).filter(t => t.length > 0);
      let cursor = 0;
      for (const text of wanted) {
        for (let j = cursor; j < liveBlocks.length; j++) {
          if (norm(liveBlocks[j].textContent) === text) {
            blocks.push(liveBlocks[j]);
            cursor = j + 1;
            break;
          }
        }
      }
    }

    liveBlocks.forEach(el => el.removeAttribute("data-tts-b"));
    return blocks.length
      ? { ok: true, title: article.title || document.title, blocks }
      : { ok: false, reason: "mapping-failed" };
  }

  function locate(nodes, starts, pos) {
    // greatest i with starts[i] <= pos
    let lo = 0,
      hi = nodes.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (starts[m] <= pos) lo = m;
      else hi = m - 1;
    }
    return [nodes[lo], Math.min(pos - starts[lo], nodes[lo].data.length)];
  }

  function sentencesForBlock(el, kind, seg) {
    const nodes = [],
      starts = [];
    let text = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: n => {
        if (!n.data || n.parentElement.closest("script,style,noscript"))
          return NodeFilter.FILTER_REJECT;
        // Only DIRECT text: text whose nearest block ancestor is el itself.
        // Text inside a nested block is that block's own to read.
        if (n.parentElement.closest(BLOCKS) !== el) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n; (n = walker.nextNode()); ) {
      starts.push(text.length);
      nodes.push(n);
      text += n.data;
    }
    if (!norm(text)) return [];

    const pieces = kind === "heading" ? [{ index: 0, segment: text }] : [...seg.segment(text)];

    const out = [];
    for (const p of pieces) {
      let s = p.index,
        e = p.index + p.segment.length;
      while (s < e && /\s/.test(text[s])) s++;
      while (e > s && /\s/.test(text[e - 1])) e--;
      if (s === e) continue;
      const range = new Range();
      const [sn, so] = locate(nodes, starts, s);
      const [en, eo] = locate(nodes, starts, e);
      range.setStart(sn, so);
      range.setEnd(en, eo);
      out.push({ text: norm(text.slice(s, e)), range });
    }

    // Merge Intl.Segmenter's false splits (abbreviations like "Dr." / "e.g."):
    // a piece starting lowercase, or following a tiny fragment, joins its
    // predecessor.
    const merged = [];
    for (const s of out) {
      const prev = merged[merged.length - 1];
      if (prev && (/^\p{Ll}/u.test(s.text) || prev.text.length < 4)) {
        prev.text += " " + s.text;
        prev.range.setEnd(s.range.endContainer, s.range.endOffset);
      } else {
        merged.push(s);
      }
    }
    return merged;
  }

  function splitLong(text) {
    const out = [];
    while (text.length > MAX_CHUNK) {
      const win = text.slice(0, MAX_CHUNK);
      let cut = Math.max(
        win.lastIndexOf("; "),
        win.lastIndexOf(", "),
        win.lastIndexOf("— "),
        win.lastIndexOf("– ")
      );
      if (cut < MAX_CHUNK * 0.3) cut = win.lastIndexOf(" ");
      if (cut <= 0) cut = MAX_CHUNK - 1;
      out.push(text.slice(0, cut + 1).trim());
      text = text.slice(cut + 1).trim();
    }
    if (text) out.push(text);
    return out;
  }

  function extract() {
    const found = findArticleBlocks();
    if (!found.ok) return found;

    const lang = (document.documentElement.lang || "en").split("-")[0] || "en";
    let seg;
    try {
      seg = new Intl.Segmenter(lang, { granularity: "sentence" });
    } catch {
      seg = new Intl.Segmenter("en", { granularity: "sentence" });
    }

    sentenceRanges = [];
    const chunks = [];
    let si = 0;
    for (const el of found.blocks) {
      const kind = /^H[1-6]$/.test(el.tagName) ? "heading" : "body";
      const sents = sentencesForBlock(el, kind, seg);
      let firstInBlock = true;
      for (const s of sents) {
        sentenceRanges[si] = s.range;
        let speak = s.text;
        if (kind === "heading" && !/[.!?:]$/.test(speak)) speak += ".";
        splitLong(speak).forEach((part, k) => {
          chunks.push({ i: si, text: part, kind, newBlock: firstInBlock && k === 0 });
        });
        si++;
        firstInBlock = false;
      }
    }
    if (chunks.length === 0) return { ok: false, reason: "empty" };
    return { ok: true, title: found.title, sentences: chunks };
  }

  function highlight(i) {
    const r = sentenceRanges[i];
    if (!r || r.collapsed) return; // page mutated under us — skip gracefully
    CSS.highlights.set("tts-current", new Highlight(r));
    const rect = r.getBoundingClientRect();
    if (rect.top < 80 || rect.bottom > innerHeight - 80) {
      const el =
        r.startContainer.nodeType === Node.TEXT_NODE
          ? r.startContainer.parentElement
          : r.startContainer;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function clearHighlight() {
    try {
      CSS.highlights.delete("tts-current");
    } catch {}
  }
})();
