const axios = require('axios');
const { execSync } = require('child_process');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');
const parse = require('parse-diff');

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

    if (action !== 'opened') {
      console.log(`PR action is '${action}' — skipping AI review (only run on 'opened').`);
      process.exit(0);
    }

    console.log(`Detected PR action: ${action}`);
    console.log(`Running full diff against base branch: ${base}`);

    // Fetch latest base branch
    execSync(`git fetch origin ${base}`, { stdio: 'inherit' });

    // Full diff between base branch and HEAD
    const fullDiff = execSync(`git diff origin/${base}...HEAD`, { stdio: 'pipe' }).toString();

    const changedFiles = execSync(`git diff --name-only origin/${base}...HEAD`, { encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean);

    if (!fullDiff.trim() || changedFiles.length === 0) {
      console.log("No changes detected in the PR. Skipping AI review.");
      process.exit(0);
    }

    console.log("Changed files:", changedFiles);

    return {
      reviewType: 'pr_opened',
      diff: fullDiff,
      changedFiles
    };
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
- Do not reference files or functions that are not present in the provided diff.
- Your response must reflect only the original code and must not attempt to fix or complete any functions.

Your JSON response must follow this exact structure:
{
  "overall_summary": "A brief summary of the change and your general impression.",
  "highlights": ["Provide detailed Highlighs about any good practices or improvements made."],
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

function matchSnippetFromDiff(diffText, filePath, codeSnippet) {
  const parsedFiles = parse(diffText);
  const targetFile = parsedFiles.find(file => file.to === filePath || file.from === filePath);

  if (!targetFile) {
    console.warn(`File '${filePath}' not found in parsed diff.`);
    return null;
  }

  const snippetLines = codeSnippet.trim().split('\n').map(l => l.trim());
  const flatChanges = targetFile.chunks.flatMap(chunk => chunk.changes)
    .filter(change => change.add && typeof change.content === 'string');

  for (let i = 0; i <= flatChanges.length - snippetLines.length; i++) {
    const window = flatChanges.slice(i, i + snippetLines.length).map(c => c.content.replace(/^\+/, '').trim());
    const exactMatch = snippetLines.every((line, j) => line === window[j]);
    if (exactMatch) {
      const startLine = flatChanges[i].ln;
      console.log(`Matched snippet in diff for file ${filePath} at line ${startLine}`);
      return { start: startLine, end: startLine + snippetLines.length - 1 };
    }
  }

  console.warn(`No match found in diff for snippet in file: ${filePath}`);
  return null;
}

async function reviewCode() {
  const { diff, reviewType, fullContext, changedFiles } = getGitDiff(); 

  const prompt = buildPrompt(diff);
  const review = CONFIG.model === 'azure' ? await requestAzure(prompt) : await requestGemini(prompt);

  console.log(`\n AI Review ouput Start \n`);
  console.log(`AI Review ouput before parsing: ${review}`);
  console.log(`\n AI Review ouput End \n`);

  const cleaned = review.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error("Failed to parse AI response JSON:", e.message);
    process.exit(1);
  }

  const { overall_summary, highlights = [], issues = [] } = parsed;
  const filteredIssues = issues.filter(issue => changedFiles.includes(issue.file));

  const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  const prNumber = process.env.GITHUB_REF.match(/refs\/pull\/(\d+)\/merge/)?.[1] ||
                   github.context.payload.pull_request?.number;
  const commitId = github.context.payload.pull_request?.head?.sha;

  let summary = `### AI Code Review Summary\n\n**📝 Overall Summary:**  \n${overall_summary}\n\n**✅ Highlights:**  \n${highlights.map(p => `- ${p}`).join('\n')}`;

  if (filteredIssues.length) {
    summary += `\n\n<details>\n<summary>⚠️ <strong>Detected Issues (${filteredIssues.length})</strong> — Click to expand</summary><br>\n`;
    for (const issue of filteredIssues) {
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

      summary += `\n- <details>\n  <summary><strong>${emoji} ${issue.title}</strong> <em>(${severityLabel})</em></summary>\n\n  **📁 File:** \`${issue.file}\`  \n  **🔢 Line:** ${issue.line || 'N/A'}\n\n  **📝 Description:**  \n  ${issue.description}\n\n  **💡 Suggestion:**  \n  ${issue.suggestion}\n  </details>`;
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

  for (const issue of filteredIssues) {
    const result = matchSnippetFromDiff(fullContext || diff, issue.file, issue.code_snippet);
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