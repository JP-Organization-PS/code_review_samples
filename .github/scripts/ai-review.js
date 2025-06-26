const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const github = require('@actions/github');
const parseDiff = require('parse-diff');

// === CONFIGURATION === //
const model = process.env.AI_MODEL || 'gemini';
const azureKey = process.env.AZURE_OPENAI_KEY;
const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
const geminiKey = process.env.GEMINI_API_KEY;
const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key=${geminiKey}`;

let diff = '';
let parsedDiff = [];

async function getPRDiff() {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is not set.");
    const octokit = github.getOctokit(token);
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    const prNumber = github.context.payload.pull_request.number;

    const commits = await octokit.rest.pulls.listCommits({ owner, repo, pull_number: prNumber });
    const commitCount = commits.data.length;

    if (commitCount < 2) {
      console.log("🔹 Only one commit in PR. Using HEAD~1 as base.");
      return execSync(`git diff HEAD~1 HEAD`).toString();
    }

    const baseSha = commits.data[commitCount - 2].sha;
    const headSha = commits.data[commitCount - 1].sha;
    console.log(`🔍 Comparing commits:\nBase: ${baseSha}\nHead: ${headSha}`);
    return execSync(`git diff ${baseSha} ${headSha}`).toString();
  } catch (e) {
    console.error("❌ Failed to get git diff:", e.message);
    process.exit(1);
  }
}

const promptTemplate = diff => `
You are an expert software engineer. Review the following code diff and return only a valid JSON array of suggestions.

STRICTLY return only the array in this format. Do not add any explanation or extra text.

[
  {
    "file": "relative/path/to/file.js",
    "line": 2,
    "severity": "[MINOR]",
    "issue": "Brief description of the issue.",
    "suggestion": "What to improve or fix.",
    "fixed_code": "Improved or corrected version of the code line"
  }
]

Here is the code diff:
\`\`\`diff
${diff}
\`\`\`
`;

async function runWithAzureOpenAI(prompt) {
  console.log("🔷 Using Azure OpenAI...");
  const res = await axios.post(
    `${azureEndpoint}/openai/deployments/${azureDeployment}/chat/completions?api-version=2024-03-01-preview`,
    {
      messages: [
        { role: "system", content: "You are a professional code reviewer." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 4096
    },
    {
      headers: {
        "api-key": azureKey,
        "Content-Type": "application/json"
      }
    }
  );
  return res.data.choices?.[0]?.message?.content?.trim() || "[]";
}

async function runWithGemini(prompt) {
  console.log("🔶 Using Gemini...");
  const res = await axios.post(
    geminiEndpoint,
    {
      contents: [{ parts: [{ text: prompt }], role: "user" }],
      generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 8192 }
    },
    { headers: { "Content-Type": "application/json" } }
  );
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "[]";
}

function extractJsonFromResponse(text) {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    const sliced = text.substring(start, end + 1).trim();
    try {
      JSON.parse(sliced);
      return sliced;
    } catch {
      console.warn("⚠️ JSON slice looks malformed.");
    }
  }

  console.warn("⚠️ No valid JSON block found.");
  return "[]";
}

function getPatchPosition(filePath, lineNumber) {
  console.log(`\n🔍 Finding patch position for ${filePath}:${lineNumber}`);
  for (const file of parsedDiff) {
    if (file.to === filePath || file.from === filePath) {
      console.log(`✅ Diff match for ${filePath}`);
      let position = 0;
      for (const chunk of file.chunks) {
        for (const line of chunk.changes) {
          position++;
          if (line.ln === lineNumber && line.add) {
            console.log(`🎯 Patch position found: ${position}`);
            return position;
          }
        }
      }
    }
  }
  console.warn(`❌ No matching position found for ${filePath}:${lineNumber}`);
  return null;
}

function getLineFromFile(filePath, lineNumber) {
  try {
    const fullPath = path.resolve(process.env.GITHUB_WORKSPACE || '.', filePath);
    const fileLines = fs.readFileSync(fullPath, 'utf-8').split('\n');
    return fileLines[lineNumber - 1] || '';
  } catch (err) {
    console.warn(`⚠️ Could not read ${filePath}:${lineNumber} - ${err.message}`);
    return '';
  }
}

async function postInlineComments(comments) {
  try {
    const token = process.env.GITHUB_TOKEN;
    const octokit = github.getOctokit(token);
    const [owner, repoName] = process.env.GITHUB_REPOSITORY.split('/');
    const prNumber = github.context.payload.pull_request.number;
    const commitSha = github.context.payload.pull_request.head.sha;

    console.log("📋 Preparing to post comments:", comments.length);

    for (const comment of comments) {
      const patchPosition = getPatchPosition(comment.file, comment.line);
      if (!patchPosition) {
        console.warn(`⚠️ Skipping comment: cannot map ${comment.file}:${comment.line}`);
        continue;
      }

      const actualCode = getLineFromFile(comment.file, comment.line);

      const body = `
**Issue:** ${comment.severity} ${comment.issue}

**Suggestion:**
${comment.suggestion}

**Original Code:**
\`\`\`js
${actualCode}
\`\`\`

**Rewritten Code:**
\`\`\`js
${comment.fixed_code || actualCode}
\`\`\`
`;

      await octokit.rest.pulls.createReviewComment({
        owner,
        repo: repoName,
        pull_number: prNumber,
        commit_id: commitSha,
        path: comment.file,
        position: patchPosition,
        body
      });

      console.log(`💬 Comment posted at ${comment.file}:${comment.line} (patch position: ${patchPosition})`);
    }
  } catch (err) {
    console.error("❌ Failed to post inline comments:", err.message);
  }
}

(async function reviewCode() {
  try {
    diff = await getPRDiff();
    parsedDiff = parseDiff(diff);

    if (!diff.trim()) {
      console.log("✅ No changes to review. Skipping.");
      return;
    }

    const prompt = promptTemplate(diff);
    let rawResponse = '';

    rawResponse = model === 'azure' ? await runWithAzureOpenAI(prompt) : await runWithGemini(prompt);

    console.log("🧠 Raw AI Response:\n", rawResponse);

    const cleanJson = extractJsonFromResponse(rawResponse);
    const comments = JSON.parse(cleanJson);

    if (!Array.isArray(comments) || comments.length === 0) {
      console.log("ℹ️ No inline suggestions found.");
      return;
    }

    await postInlineComments(comments);
  } catch (err) {
    console.error("❌ AI Review Error:", err.message);
  }
})();
