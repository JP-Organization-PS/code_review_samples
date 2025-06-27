// ai-review.js
const axios = require('axios');
const { execSync } = require('child_process');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');
const stringSimilarity = require('string-similarity');

const CONFIG = {
  model: process.env.AI_MODEL || 'gemini',
  azure: {
    key: process.env.AZURE_OPENAI_KEY,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
  },
  gemini: {
    key: process.env.GEMINI_API_KEY,
    endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key=${process.env.GEMINI_API_KEY}`,
  },
};

function getGitDiff() {
  try {
    const base = process.env.GITHUB_BASE_REF || 'main';
    execSync(`git fetch origin ${base}`, { stdio: 'inherit' });
    const diff = execSync(`git diff origin/${base}...HEAD`, { stdio: 'pipe' }).toString();
    if (!diff.trim()) {
      console.log("No changes found in PR. Skipping AI review.");
      process.exit(0);
    }
    console.log("Diff generated from PR changes.");
    return diff;
  } catch (e) {
    console.error("Failed to get diff from PR branch:", e.message);
    process.exit(1);
  }
}

function buildPrompt(diff) {
  return `You are an expert software engineer and code reviewer specializing in clean code, security, performance, and maintainability.

Please review the following code diff and respond in strict JSON format.

VERY IMPORTANT:
- Do not rewrite or reformat code snippets.
- Do not add extra lines (e.g., inner try-except, print statements, comments).
- When including the 'code_snippet', copy the snippet **exactly as shown** in the diff.
- Preserve indentation and formatting.
- Your response must only reflect the original code — do not "fix" or "complete" any functions.

Your JSON output must follow this format:
{ "overall_summary": "...", "positive_aspects": ["..."], "issues": [{ "severity": "...", "title": "...", "description": "...", "suggestion": "...", "file": "...", "line": "...", "code_snippet": "..." }] }

Respond with only a single valid JSON object. No Markdown, headers, or commentary.

Here is the code diff:

${diff}`;
}

async function requestAzure(prompt) {
  console.log("Using Azure OpenAI...");
  const { endpoint, deployment, key } = CONFIG.azure;
  const res = await axios.post(
    `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-03-01-preview`,
    {
      messages: [
        { role: "system", content: "You are a professional code reviewer." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    },
    { headers: { 'api-key': key, 'Content-Type': 'application/json' } }
  );
  return res.data.choices?.[0]?.message?.content?.trim() || "No response from Azure.";
}

async function requestGemini(prompt) {
  console.log("Using Gemini...");
  const res = await axios.post(
    CONFIG.gemini.endpoint,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, topP: 0.9, maxOutputTokens: 8192 },
    },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "No response from Gemini.";
}

function matchSnippet(filePath, codeSnippet, threshold = 0.85) {
  if (!fs.existsSync(filePath)) return null;

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const snippetLines = codeSnippet.trim().split('\n').map(l => l.trim());

  // First: Try exact match
  for (let i = 0; i <= lines.length - snippetLines.length; i++) {
    const window = lines.slice(i, i + snippetLines.length).map(l => l.trim());
    const exactMatch = snippetLines.every((line, j) => window[j] === line);
    if (exactMatch) {
      return { start: i + 1, end: i + snippetLines.length };
    }
  }

  // Fallback: Try fuzzy matching
  for (let i = 0; i <= lines.length - snippetLines.length; i++) {
    const window = lines.slice(i, i + snippetLines.length).map(l => l.trim());
    const similarity = snippetLines.map((line, j) =>
      stringSimilarity.compareTwoStrings(line, window[j])
    );
    const average = similarity.reduce((a, b) => a + b, 0) / similarity.length;

    if (average >= threshold) {
      return { start: i + 1, end: i + snippetLines.length };
    }
  }

  return null;
}

function matchSnippet_old(filePath, codeSnippet) {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const snippetLines = codeSnippet.trim().split('\n').map(l => l.trim());

  for (let i = 0; i <= lines.length - snippetLines.length; i++) {
    let matched = true;
    for (let j = 0; j < snippetLines.length; j++) {
      if (!lines[i + j].includes(snippetLines[j])) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { start: i + 1, end: i + snippetLines.length };
    }
  }
  return null;
}

async function reviewCode() {
  const diff = getGitDiff();
  const prompt = buildPrompt(diff);
  const review = CONFIG.model === 'azure' ? await requestAzure(prompt) : await requestGemini(prompt);

  const parsed = JSON.parse(review.replace(/```json|```/g, '').trim());
  const { overall_summary, positive_aspects, issues = [] } = parsed;

  const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  const prNumber = process.env.GITHUB_REF.match(/refs\/pull\/(\d+)\/merge/)?.[1];
  const commitId = github.context.payload.pull_request.head.sha;

  let summary = `### 🔍 AI Code Review Summary\n\n**📝 Overall Summary:**  \n${overall_summary}\n\n**✅ Positive Aspects:**  \n${positive_aspects.map(p => `- ${p}`).join('\n')}`;

  if (issues.length) {
    summary += `\n\n<details>\n<summary>⚠️ <strong>Detected Issues (${issues.length})</strong> — Click to expand</summary><br>\n`;
    for (const issue of issues) {
      const emoji = issue.severity === 'CRITICAL' || issue.severity === 'MAJOR' ? '🔴' : issue.severity === 'MINOR' ? '🟠' : issue.severity === 'INFO' ? '🔵' : '🟢';
      summary += `
- <details>
  <summary><strong>${emoji} ${issue.title}</strong> <em>(${issue.severity})</em></summary>

  **📁 File:** \`${issue.file}\`  
  **🔢 Line:** ${issue.line || 'N/A'}

  **📝 Description:**  
  ${issue.description}

  **💡 Suggestion:**  
  ${issue.suggestion}
  </details>`;
    }
    summary += `\n</details>`;
  }

  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: commitId,
    event: 'COMMENT',
    body: summary,
  });
  console.log(`Posted summary comment.`);

  for (const issue of issues) {
    const result = matchSnippet(path.resolve(process.cwd(), issue.file), issue.code_snippet);
    if (!result) {
      console.warn(`Could not match code snippet for issue: '${issue.title}' in file: ${issue.file} Snippet: ${issue.code_snippet}`);
      continue;
    }

    const priority = issue.severity === 'CRITICAL' || issue.severity === 'MAJOR'
      ? '🔴 High Priority'
      : issue.severity === 'MINOR'
        ? '🟠 Medium Priority'
        : issue.severity === 'INFO'
          ? '🔵 Info'
          : '🟢 Low Priority';

    const body = `#### ${priority} - ${issue.title}\n\n**Issue:**  \n${issue.description}  \n\n**Suggestion:**  \n${issue.suggestion}`;

    await octokit.rest.pulls.createReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      path: issue.file,
      line: result.start,
      side: 'RIGHT',
      body,
    });
    console.log(`Posted inline comment: ${issue.title}`);
  }
}

reviewCode();