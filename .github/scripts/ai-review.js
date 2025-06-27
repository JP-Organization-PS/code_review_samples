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

CRITICAL INSTRUCTIONS – FOLLOW EXACTLY:
- DO NOT rewrite, reformat, or modify code snippets.
- DO NOT add, remove, or alter any lines of code (including try/except blocks, print/log statements, or comments).
- DO NOT infer missing logic or auto-complete partial functions.
- The 'code_snippet' field MUST BE AN EXACT COPY of the code shown in the diff.
- Maintain original formatting, spacing, and indentation as-is.

JSON RESPONSE FORMAT:
{
  "overall_summary": "A brief summary of the change and your general impression.",
  "highlights": ["Highlight any good practices or improvements made."],
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
  const res = await axios.post(
    CONFIG.gemini.endpoint,
    {
      contents: [
        {
          role: 'system',
          parts: [
            {
              text: 'You are a precise code reviewer. NEVER modify or improve code snippets from the user. The code_snippet field must be an exact copy of the original code diff. DO NOT add, remove, reformat, or auto-correct code snippets.'
            }
          ]
        },
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: { temperature: 0.1, topP: 0.9, maxOutputTokens: 8192 }
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "No response from Gemini.";
}


function matchSnippet(filePath, codeSnippet, threshold = 0.85) {
  if (!fs.existsSync(filePath)) return null;

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const snippetLines = codeSnippet
    .trim()
    .split('\n')
    .map(line => line.replace(/^[-+]\s*/, '').trim()) // Strip leading '+' or '-' and whitespace
    .filter(line => line.length > 0); // Ignore empty lines

  // First: Try exact match
  for (let i = 0; i <= lines.length - snippetLines.length; i++) {
    const window = lines.slice(i, i + snippetLines.length).map(l => l.trim());
    const exactMatch = snippetLines.every((line, j) => window[j] === line);
    if (exactMatch) {
      console.log(`Matched using exact logic at line ${i + 1}`);
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
      console.log(`Matched using fuzzy logic (score: ${average.toFixed(2)}) at line ${i + 1}`);
      return { start: i + 1, end: i + snippetLines.length };
    }
  }

  console.warn(`No match found for the code snippet:\n${codeSnippet}`);
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