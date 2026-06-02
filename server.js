// ============================================================
//  COLLABAI — Dual Groq Agent Backend
//  llama-3.3-70b-versatile  = Drafter
//  llama-3.1-8b-instant     = Refiner
// ============================================================
require('dotenv').config();
const express = require("express");
const cors    = require("cors");
const Groq    = require("groq-sdk");
 
const app  = express();
const PORT = 3000;
app.use(cors());
app.use(express.json());
 
// ── YOUR GROQ API KEY ────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY; // Set this in your .env file or environment variables
// ────────────────────────────────────────────────────────────
 
const groq = new Groq({ apiKey: GROQ_API_KEY });
 
const DRAFTER_MODEL = "llama-3.3-70b-versatile";
const REFINER_MODEL = "llama-3.1-8b-instant";
 
async function callGroq(model, systemPrompt, userContent, maxTokens = 2500) {
  const res = await groq.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userContent  },
    ],
    max_tokens: maxTokens,
    temperature: 0.3,
  });
  return res.choices[0].message.content;
}
 
function classifyTask(prompt) {
  const lower = prompt.toLowerCase();
  if (/\b(debug|error|exception|traceback|crash|fix|broken|not working|fails?|bug)\b/.test(lower)) return 'debug';
  if (/\b(architect|design system|structure|plan|how (should|would) i|approach|strategy)\b/.test(lower)) return 'architecture';
  if (/\b(explain|how does|what is|what are|why does|understand|concept|difference between)\b/.test(lower)) return 'explain';
  if (/\b(build|create|write|make|generate|code|function|class|component|script|app|api|endpoint)\b/.test(lower)) return 'code-heavy';
  return 'default';
}
 
const DRAFTER_PROMPT = `You are a highly capable, conversational AI co-pilot. You have personality—you are sharp, highly intelligent, friendly, and speak like a real human, not a corporate robot. 

You adapt instantly to what the user needs:
- IF IT IS A GREETING: Just say hi naturally and casually. Keep it to one or two sentences.
- IF IT IS A CREATIVE/WRITING TASK (posts, emails, brainstorming): Be a brilliant copywriter. Use engaging, natural language, good pacing, and appropriate tone. 
- IF IT IS A TECHNICAL TASK (coding, debugging, architecture): Switch to expert engineer mode. Write clean, well-commented code. 
IMPORTANT FOR CODE: Put ALL code inside a SINGLE fenced code block using triple backticks. 

Never apologize excessively, and never output robotic "How can I help you today?" manuals. Be confident, direct, and helpful.`;
 
const REFINER_PROMPT = `You are the final editor. You will receive a user's prompt and a first draft from another AI.

Your job is to deliver a clean, polished final answer that keeps the Drafter's natural, human personality intact while ensuring the formatting is perfect for the UI.

FORMATTING RULES (STRICT):
- Use <p> tags for all regular text and explanations.
- If it is a social media post or creative writing, respect the formatting and line breaks (use <br> or multiple <p> tags), and keep the emojis.
- Only use <h3> tags and <ul>/<li> lists if the response is a long, structured technical explanation.
- Use ONE single <pre> tag for the ENTIRE code section (if any code exists).
- Do NOT output any markdown whatsoever — no **bold**, no # headings, no backtick code fences.
- Do NOT include any preamble like "Here is the refined answer". Jump straight in.

Review the draft, fix any weird phrasing or bugs, apply the HTML tags silently, and output the final response.`;
 
 
// ── MARKDOWN TO HTML CONVERTER ───────────────────────────────
function markdownToHtml(text) {
  // Step 1: Extract ALL code blocks first and replace with placeholders
  const codeBlocks = [];
 
  // Terminal command keywords — these get yellow terminal styling
  const terminalPattern = /^\s*(pip|pip3|npm|npx|yarn|node|python|python3|cd|mkdir|git|curl|brew|apt|sudo|chmod|mv|cp|ls|export|set|conda|docker|rustup|cargo)\b/m;
 
  let html = text.replace(/```([\w]*)\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const trimmed = code.trimEnd();
    const escaped = trimmed
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const idx = codeBlocks.length;
    // Detect if this is a terminal/shell block
    const isTerminal = lang === 'bash' || lang === 'shell' || lang === 'sh' || lang === 'cmd' || terminalPattern.test(trimmed);
    if (isTerminal) {
      // Prefix each line with a prompt span
      const lines = escaped.split('\n').map(l => `<span class="prompt">${l}</span>`).join('\n');
      codeBlocks.push(`<pre class="terminal">${lines}</pre>`);
    } else {
      codeBlocks.push(`<pre>${escaped}</pre>`);
    }
    return `%%CODEBLOCK_${idx}%%`;
  });
 
  // Step 1b: Merge consecutive code blocks that got split (e.g. pip install on its own)
  html = html.replace(/%%CODEBLOCK_(\d+)%%\s*\n\s*([^\n<]+)\n\s*%%CODEBLOCK_(\d+)%%/g, (_, i, middle, j) => {
    const escaped = middle.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const merged = codeBlocks[i].replace(/<\/pre>$/, '') + '\n' + escaped + '\n' + codeBlocks[j].replace(/^<pre>/, '');
    const idx = codeBlocks.length;
    codeBlocks.push(merged);
    return `%%CODEBLOCK_${idx}%%`;
  });
 
  // Step 1c: Also catch plain text lines sandwiched between two code blocks
  html = html.replace(/%%CODEBLOCK_(\d+)%%([\s\S]*?)%%CODEBLOCK_(\d+)%%/g, (match, i, middle, j) => {
    const trimmed = middle.trim();
    if (!trimmed || trimmed.length < 80) {
      const escaped = trimmed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const merged = codeBlocks[i].replace(/<\/pre>$/, '') + (escaped ? '\n' + escaped : '') + '\n' + codeBlocks[j].replace(/^<pre>/, '');
      const idx = codeBlocks.length;
      codeBlocks.push(merged);
      return `%%CODEBLOCK_${idx}%%`;
    }
    return match;
  });
 
  // Step 2: Headings
  html = html.replace(/^#{3,6}\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^#{1,2}\s+(.+)$/gm, '<h3>$1</h3>');
 
  // Step 3: Bold and inline code
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
 
  // Step 4: Unordered lists — collect consecutive bullet lines
  html = html.replace(/((?:^[ \t]*[*\-+][ \t]+.+(?:\r?\n|$))+)/gm, (block) => {
    const items = block.trim().split(/\r?\n/).map(line =>
      `<li>${line.replace(/^[ \t]*[*\-+][ \t]+/, '').trim()}</li>`
    ).join('');
    return `<ul>${items}</ul>\n`;
  });
 
  // Step 5: Ordered lists
  html = html.replace(/((?:^[ \t]*\d+\.[ \t]+.+(?:\r?\n|$))+)/gm, (block) => {
    const items = block.trim().split(/\r?\n/).map(line =>
      `<li>${line.replace(/^[ \t]*\d+\.[ \t]+/, '').trim()}</li>`
    ).join('');
    return `<ol>${items}</ol>\n`;
  });
 
  // Step 6: Wrap plain lines in <p>, skip already-tagged and placeholders
  const lines = html.split(/\r?\n/);
  const wrapped = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^<(h[1-6]|ul|ol|li|pre|div|blockquote)/.test(trimmed)) {
      wrapped.push(trimmed);
    } else if (/^%%CODEBLOCK_\d+%%$/.test(trimmed)) {
      wrapped.push(trimmed);
    } else {
      wrapped.push(`<p>${trimmed}</p>`);
    }
  }
  html = wrapped.join('\n');
 
  // Step 7: Restore code blocks
  codeBlocks.forEach((block, idx) => {
    html = html.replace(`%%CODEBLOCK_${idx}%%`, block);
  });
 
  return html;
}
 
// ── MAIN ENDPOINT ─────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt provided." });
 
  const bar = "━".repeat(44);
  console.log(`\n${bar}`);
  console.log(`[ORCHESTRATOR] "${prompt.slice(0, 80)}"`);
 
  try {
    const taskType = classifyTask(prompt);
    console.log(`[ROUTER] Task: ${taskType}`);
 
    console.log(`[Drafter: llama-3.3-70b] Working...`);
    const draft = await callGroq(DRAFTER_MODEL, DRAFTER_PROMPT, prompt, 2500);
    console.log(`[Drafter] Done.`);
 
    console.log(`[Refiner: llama-3.1-8b] Reviewing and refining...`);
    const refineInput = `User's original question:\n${prompt}\n\n---\nFirst draft to refine:\n${draft}`;
    const rawFinal = await callGroq(REFINER_MODEL, REFINER_PROMPT, refineInput, 2500);
    console.log(`[Refiner] Done. Sending response.\n${bar}\n`);
 
    // Convert ALL markdown to HTML — no matter what the model outputs
    const final = markdownToHtml(rawFinal);
 
    res.json({
      final,
      label: "CollabAI — llama-3.3-70b drafted · llama-3.1-8b refined",
    });
 
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    res.status(500).json({ error: "Pipeline failed.", detail: err.message });
  }
});
 
app.listen(PORT, () => {
  console.log(`\n✅  CollabAI running → http://localhost:${PORT}`);
  console.log(`    Drafter : llama-3.3-70b-versatile`);
  console.log(`    Refiner : llama-3.1-8b-instant`);
  console.log(`    100% free on Groq.\n`);
});