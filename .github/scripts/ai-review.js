const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const github = require('@actions/github');
const parseDiff = require('parse-diff');

const model = process.env.AI_MODEL || 'gemini';

const azureKey = process.env.AZURE_OPENAI_KEY;
const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;

const geminiKey = process.env.GEMINI_API_KEY;
const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key=${geminiKey}`;

async function getDiffFromLastTwoCommits() {
  try {
    const token = process.env.GITHUB_TOKEN;
    const octokit = github.getOctokit(token);
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    const prNumber = github.context.payload.pull_request.number;

    const commits = await octokit.rest.pulls.listCommits({ owner, repo, pull_number: prNumber });
    const commitCount = commits.data.length;

    if (commitCount < 2) {
      console.log("🔹 PR has only one commit. Falling back to HEAD~1 diff.");
      return execSync(`git diff HEAD~1 HEAD`).toString();
    } else {
      const baseSha = commits.data[commitCount - 2].sha;
      const headSha = commits.data[commitCount - 1].sha;
      return execSync(`git diff ${baseSha} ${headSha}`).toString();
    }
  } catch (e) {
    console.error("❌ Failed to get commit diff:", e.message);
    return '';
  }
}

function promptTemplate(diff) {
  return `
You are an expert software engineer. Review the following code diff and return only a valid JSON array of suggestions.

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
}

async function runWithGemini(prompt) {
  const res = await axios.post(
    geminiEndpoint,
    {
      contents: [
        {
          parts: [{ text: prompt }],
          role: "user"
        }
      ],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 8192
      }
    },
    {
      headers: { "Content-Type": "application/json" }
    }
  );
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "[]";
}

function extractJsonFromResponse(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match) return match[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) return text.substring(start, end + 1);
  return "[]";
}

async function postInlineComments(comments, diff) {
  const token = process.env.GITHUB_TOKEN;
  const octokit = github.getOctokit(token);
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  const prNumber = github.context.payload.pull_request.number;
  const commitSha = github.context.payload.pull_request.head.sha;

  const parsed = parseDiff(diff);

  for (const comment of comments) {
    const file = parsed.find(f => f.to === comment.file || f.from === comment.file);
    if (!file) continue;

    let position = 0, found = false;
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        position++;
        if (change.ln === comment.line && change.add) {
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      console.warn(`⚠️ Skipping comment: cannot map ${comment.file}:${comment.line}`);
      continue;
    }

    await octokit.rest.pulls.createReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      path: comment.file,
      position,
      body: `**Issue:** ${comment.severity} ${comment.issue}

**Suggestion:**
${comment.suggestion}

**Rewritten Code:**
\
\`\`\`js
${comment.fixed_code || ''}
\`\`\``
    });
  }
}

(async function reviewCode() {
  const diff = await getDiffFromLastTwoCommits();
  if (!diff) return;
  const prompt = promptTemplate(diff);
  const raw = await runWithGemini(prompt);
  const json = extractJsonFromResponse(raw);

  try {
    const suggestions = JSON.parse(json);
    await postInlineComments(suggestions, diff);
  } catch (e) {
    console.error("❌ Failed to parse or post comments:", e.message);
  }
})();
