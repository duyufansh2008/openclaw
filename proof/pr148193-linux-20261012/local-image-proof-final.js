const [image] = await catalog.search("local_image", { limit: 1 });
if (!image) throw new Error("local_image not discovered");
const paths = ["ocr.png", "~/workspace/ocr.png", "media://inbound/ocr.png", "/home/proof/.openclaw/attachments/subagents/main/ff89f3070705f3f94197de68212f21ad/ocr.png"];
const results = [];
for (const path of paths) {
  const r = await image({ path, task: "ocr", prompt: "Describe its colors." });
  if (typeof r.text !== "string" || !/OPENCLAW\s+OCR\s+4827/i.test(r.text)) throw new Error("OCR text missing at " + path);
  if (r.task !== "ocr" || r.model !== "glm-ocr-q8_0") throw new Error("wrong typed OCR route");
  results.push(r);
}
const vision = await image({ path: "vision.png", prompt: "Which shape is above the blue circle? Answer with its color and shape." });
if (vision.task !== "vision" || !/red\s+square/i.test(vision.text)) throw new Error("default vision result incorrect");
let denied = false;
let denial;
try { await image({ path: "/home/proof/unapproved/ocr.png", task: "ocr" }); }
catch (error) { denied = true; denial = String(error); }
if (!denied) throw new Error("unapproved outside-workspace path allowed");
json({ state: { discovered: true, ocr: results, vision, outsideWorkspaceDenied: denied, denial } });
