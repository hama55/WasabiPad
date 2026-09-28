const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Feature: AAA input is rendered as an HTML preview.
// Scenario: The renderer writes escaped input to the explicitly chosen output path.
// Given: A temporary .aaa file contains HTML-like unsafe text.
// When: The renderer CLI receives that input and an output path.
// Then: The chosen output contains HTML with the unsafe text escaped.
test("Scenario: Writes escaped AAA content to the chosen HTML output", async () => {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "wasabipad-external-preview-aaa-"),
  );

  try {
    const inputPath = path.join(temporaryDirectory, "unsafe.aaa");
    const outputPath = path.join(temporaryDirectory, "chosen-preview.html");
    await fs.writeFile(inputPath, "<script>alert('x')</script> &", "utf8");

    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "render-preview.cjs"), inputPath, outputPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);

    const html = await fs.readFile(outputPath, "utf8");
    assert.ok(html.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp;"));
    assert.ok(!html.includes("<script>alert('x')</script>"));
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
