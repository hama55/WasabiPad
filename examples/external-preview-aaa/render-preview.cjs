const fs = require("node:fs/promises");
const path = require("node:path");

const HTML_ESCAPE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]);
}

async function renderPreview() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath || process.argv.length !== 4) {
    throw new Error("使い方: node render-preview.cjs <inputPath> <outputPath>");
  }

  const [template, input] = await Promise.all([
    fs.readFile(path.join(__dirname, "template.html"), "utf8"),
    fs.readFile(inputPath, "utf8"),
  ]);
  const fileName = escapeHtml(path.basename(inputPath));
  const content = escapeHtml(input);

  const output = template.replace(/\{\{(FILE_NAME|CONTENT)\}\}/g, (token, name) =>
    name === "FILE_NAME" ? fileName : content,
  );
  await fs.writeFile(outputPath, output, "utf8");
}

renderPreview().catch((error) => {
  process.stderr.write(`外部プレビューの生成に失敗しました: ${error.message}\n`);
  process.exitCode = 1;
});
