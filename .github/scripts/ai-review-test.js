// ai-review.js with parse Diff
const axios = require('axios');
const { execSync } = require('child_process');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');
const stringSimilarity = require('string-similarity');
const parseDiff = require('parse-diff');

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

CRITICAL INSTRUCTIONS - FOLLOW EXACTLY:
- DO NOT rewrite, reformat, or modify code snippets.
- DO NOT add, remove, or alter any lines of code (including try/except blocks, print/log statements, or comments).
- DO NOT infer missing logic or auto-complete partial functions.
- The 'code_snippet' field MUST ONLY include lines that are part of the actual code diff (i.e., added or modified lines in the PR).
- DO NOT include any unchanged code.
- Maintain original formatting, spacing, and indentation as-is.
- Each "code_snippet" must refer to a single continuous block of code only.
- Never include more than one function or separated code chunks in a single code_snippet field.

JSON RESPONSE FORMAT:
{
  "overall_summary": "A brief summary of the change and your general impression.",
  "highlights": [Highlight any good practices or improvements made.],
  "issues": [
    {
      "severity": "Use tags like [INFO], [MINOR], [MAJOR], [CRITICAL] before each issue/suggestion.",
      "title": "...",
      "description": "Mention any bugs, anti-patterns, security concerns, or performance problems",
      "suggestion": "Recommend improvements, better design patterns, or more idiomatic approaches.",
      "file": "...",
      "line": "...",
      "code_snippet": "This field MUST BE AN EXACT COPY of the original code diff. DO NOT add, remove, reformat, or auto-correct code snippets."
    }
  ]
}

VERY IMPORTANT:
- Your response must be a single valid JSON object.
- Do NOT include Markdown, backticks, code fences, or formatting.
- The output must be directly parseable as JSON.

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
  const systemInstruction = `You are a precise code reviewer. NEVER modify or improve code snippets from the user. The code_snippet field must be an exact copy of the original code diff. DO NOT add, remove, reformat, or auto-correct code snippets.`;

  const res = await axios.post(
    CONFIG.gemini.endpoint,
    {
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemInstruction}\n\n${prompt}` }]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        topP: 0.9,
        maxOutputTokens: 8192
      }
    },
    {
      headers: { 'Content-Type': 'application/json' }
    }
  );

  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "No response from Gemini.";
}

function matchSnippet(diff, filePath, codeSnippet, threshold = 0.85) {
  const files = parseDiff(diff);
  const file = files.find(f => f.to === filePath || f.from === filePath);
  if (!file) {
    console.warn(`File ${filePath} not found in diff.`);
    return null;
  }

  const snippetLines = codeSnippet
    .trim()
    .split('\n')
    .map(line => line.trim());

  for (const chunk of file.chunks) {
    const changes = chunk.changes;

    for (let i = 0; i <= changes.length - snippetLines.length; i++) {
      const window = changes.slice(i, i + snippetLines.length);
      const windowLines = window.map(c => c.content.replace(/^[-+]/, '').trim());

      const exactMatch = snippetLines.every((line, j) => windowLines[j] === line);
      if (exactMatch) {
        const firstLine = window.find(w => w.ln2 !== undefined || w.ln !== undefined);
        const lineNumber = firstLine?.ln2 || firstLine?.ln || null;
        console.log(`✅ Exact match at ${filePath}:${lineNumber}`);
        return { file: filePath, start: lineNumber, end: lineNumber + snippetLines.length - 1 };
      }

      const similarityScores = snippetLines.map((line, j) =>
        stringSimilarity.compareTwoStrings(line, windowLines[j] || '')
      );
      const avgSimilarity = similarityScores.reduce((a, b) => a + b, 0) / similarityScores.length;

      if (avgSimilarity >= threshold) {
        const firstLine = window.find(w => w.ln2 !== undefined || w.ln !== undefined);
        const lineNumber = firstLine?.ln2 || firstLine?.ln || null;
        console.log(`🤏 Fuzzy match (${avgSimilarity.toFixed(2)}) at ${filePath}:${lineNumber}`);
        return { file: filePath, start: lineNumber, end: lineNumber + snippetLines.length - 1 };
      }
    }
  }

  console.warn(`❌ No match found for snippet in ${filePath}:
${codeSnippet}`);
  return null;
}

async function reviewCode() {
  const diff = getGitDiff();
  const prompt = buildPrompt(diff);
  const review = CONFIG.model === 'azure' ? await requestAzure(prompt) : await requestGemini(prompt);

  const cleaned = review
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .replace(/\\`/g, '`')
    .trim();

  const parsed = JSON.parse(cleaned);
  const { overall_summary, highlights, issues = [] } = parsed;

  const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  const prNumber = process.env.GITHUB_REF.match(/refs\/pull\/(\d+)\/merge/)?.[1];
  const commitId = github.context.payload.pull_request.head.sha;

  let summary = `### AI Code Review Summary\n\n**📝 Overall Summary:**  \n${overall_summary}\n\n**✅ Highlights:**  \n${highlights.map(p => `- ${p}`).join('\n')}`;

  if (issues.length) {
    summary += `\n\n<details>\n<summary>⚠️ <strong>Detected Issues (${issues.length})</strong> — Click to expand</summary><br>\n`;
    for (const issue of issues) {
      let emoji = '🟢';
      let severityLabel = 'Low Priority';

      if (issue.severity === 'CRITICAL') {
        emoji = '🔴';
        severityLabel = 'Critical Priority';
      } else if (issue.severity === 'MAJOR') {
        emoji = '🔴';
        severityLabel = 'High Priority';
      } else if (issue.severity === 'MINOR') {
        emoji = '🟠';
        severityLabel = 'Medium Priority';
      } else if (issue.severity === 'INFO') {
        emoji = '🔵';
        severityLabel = 'Informational';
      }

      summary += `
- <details>
  <summary><strong>${emoji} ${issue.title}</strong> <em>(${severityLabel})</em></summary>

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
    const result = matchSnippet(diff, issue.file, issue.code_snippet);
    if (!result) {
      console.warn(`Could not match code snippet for issue: '${issue.title}' in file: ${issue.file}`);
      continue;
    }

    const priority = issue.severity === 'CRITICAL' || issue.severity === 'MAJOR'
      ? '🔴 High Priority'
      : issue.severity === 'MINOR'
        ? '🟠 Medium Priority'
        : issue.severity === 'INFO'
          ? '🔵 Informational'
          : '🟢 Low Priority';

    const body = `#### ${priority}\n\n**Issue: ${issue.title}**  \n${issue.description}  \n\n**Suggestion:**  \n${issue.suggestion}`;

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