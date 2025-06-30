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
    const base = process.env.GITHUB_BASE_REF;

    if (!base) {
      console.log("Not a pull request context. Skipping AI review.");
      process.exit(0);
    }

    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const action = event.action;

    console.log(`Detected PR action: ${action}`);
    console.log(`Running diff against base branch: ${base}`);

    execSync(`git fetch origin ${base}`, { stdio: 'inherit' });

    // Full PR diff
    const fullDiff = execSync(`git diff origin/${base}...HEAD`, { stdio: 'pipe' }).toString();

    if (!fullDiff.trim()) {
      console.log("No changes found in PR. Skipping AI review.");
      process.exit(0);
    }

    if (action === 'opened') {
      console.log("PR opened → performing full diff review.");
      return {
        reviewType: 'full',
        diff: fullDiff
      };
    }

    if (action === 'synchronize_test') {
      console.log("PR updated with new commits → performing latest commit vs main diff.");

      let latestCommitDiff;
      try {
        const latestCommit = execSync('git rev-parse HEAD').toString().trim();
        latestCommitDiff = execSync(`git diff origin/${base} ${latestCommit}`, { stdio: 'pipe' }).toString();
      } catch (err) {
        console.warn("Could not compare against base. Falling back to full diff.");
        latestCommitDiff = fullDiff;
      }

      return {
        reviewType: 'latest_commit_vs_main',
        diff: latestCommitDiff,
        fullContext: fullDiff
      };
    }

    console.log(`Unhandled PR action: ${action}. Skipping AI review.`);
    process.exit(0);

  } catch (e) {
    console.error("Failed to get diff from PR branch:", e.message);
    process.exit(1);
  }
}

function buildPrompt(diff) {
  return `You are an expert software engineer and code reviewer, specializing in clean code, security, performance, and maintainability.

Please review the following code diff and respond in strict JSON format without making any edits to the actual code.
IMPORTANT GUIDELINES:
- Do not rewrite, reformat, or modify any code snippets.
- Do not add any new lines (e.g., inner try-except, print statements, or comments).
- When including a code_snippet, copy it exactly as shown in the diff.
- Preserve the original indentation and formatting.
- Your response must reflect only the original code and must not attempt to fix or complete any functions.

Your JSON response must follow this exact structure:
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
Respond with a single valid JSON object only. Do not include Markdown, code blocks, backticks, or any additional formatting.

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

async function reviewCode() {
  const { diff, reviewType, fullContext } = getGitDiff(); 
  const prompt = buildPrompt(diff);
  const review = CONFIG.model === 'azure' ? await requestAzure(prompt) : await requestGemini(prompt);

  console.log(`\n AI Review ouput Start \n`);
  console.log(`AI Review ouput before parsing: ${review}`);
  console.log(`\n AI Review ouput End \n`);

  const cleaned = review
  .replace(/^```json\s*/i, '')         // remove opening ```json and optional whitespace
  .replace(/\s*```$/, '')              // remove closing ``` at the end
  .trim();


  const parsed = JSON.parse(cleaned);
  const { overall_summary, positive_aspects, issues = [] } = parsed;

  const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  const prNumber = process.env.GITHUB_REF.match(/refs\/pull\/(\d+)\/merge/)?.[1];
  const commitId = github.context.payload.pull_request.head.sha;

  let summary = `### AI Code Review Summary\n\n**📝 Overall Summary:**  \n${overall_summary}\n\n**✅ Highlights:**  \n${positive_aspects.map(p => `- ${p}`).join('\n')}`;

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