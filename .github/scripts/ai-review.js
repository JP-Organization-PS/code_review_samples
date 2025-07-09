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
  return `You are an **extremely meticulous, highly critical, and relentlessly exhaustive expert software engineer and code reviewer**. Your paramount mission is to conduct a forensic analysis of the provided code. Your goal is to identify and report *every single possible issue, flaw, anti-pattern, potential bug, vulnerability, inefficiency, design imperfection, or area for improvement*, no matter how minor, subtle, or seemingly insignificant.

Adopt the mindset of a combined:
- **Senior Software Architect**: Evaluating design patterns, modularity, scalability, extensibility, and maintainability.
- **Security Auditor**: Scrutinizing for all known vulnerabilities, insecure practices, and potential attack vectors (including DoS).
- **Performance Engineer**: Analyzing for computational inefficiencies, memory usage, resource leaks, and latency issues under all loads.
- **Quality Assurance Lead**: Identifying edge cases, unexpected behaviors, logical flaws, and testability challenges.
- **Code Standards Enforcer**: Checking for adherence to best practices, idiomatic language use, and readability conventions (e.g., PEP 8 for Python).
- **Reliability Engineer**: Assessing robustness, error handling, and system stability under adverse conditions (e.g., malformed inputs, resource exhaustion).

**CRITICAL FOCUS AREAS FOR IDENTIFICATION:**
- **Runtime Safety & Resource Exhaustion (HIGH PRIORITY)**: Actively look for scenarios where valid but extreme inputs (e.g., very large numbers, long strings, deeply nested data) could lead to 'OverflowError', 'MemoryError', excessive CPU consumption, infinite loops/recursion, or denial-of-service (DoS) vulnerabilities. Explicitly consider operations like exponentiation ('x**y' with large 'y'), division by near-zero, complex string manipulations, or unbounded loops.
- **Numerical Precision & Stability**: Identify potential for floating-point inaccuracies, 'NaN'/'Infinity' propagation, underflow/overflow, and issues with comparisons of floating-point numbers.
- **Input Validation & Sanitization**: Comprehensive checks for types, ranges, formats, and content, especially for user-controlled or external inputs.
- **Error Handling Robustness**: Proper exception types, clear error messages, logging, graceful degradation, and prevention of sensitive information disclosure.
- **Security Vulnerabilities**: All common OWASP Top 10 categories, insecure deserialization, privilege escalation, unauthenticated access, etc.
- **Performance Bottlenecks**: Inefficient algorithms, unnecessary data copying, repeated computations, suboptimal data structures, excessive I/O.
- **Maintainability & Readability**: Complex logic, poor naming, inconsistent style, lack of modularity, tight coupling, insufficient documentation.
- **Design Flaws**: Architectural weaknesses, violation of SOLID principles, lack of extensibility, poor testability.
- **Pythonic Idioms & Best Practices**: Deviations from standard, efficient, and readable Python patterns.
- **Resource Management**: Unclosed files, network connections, database connections, unreleased locks, memory leaks.

Review the following code diff and respond exclusively in strict JSON format.

IMPORTANT GUIDELINES FOR YOUR ANALYSIS AND OUTPUT:
- **Maximal Issue Identification (No Exceptions)**: Leave no stone unturned. Analyze *every line and every aspect* of the code shown within the diff's full function/class context. Report absolutely everything you find. Be particularly aggressive in identifying potential runtime failures, resource exhaustion, security vulnerabilities (including subtle DoS vectors), numerical instabilities, and performance degradations under valid but extreme or problematic inputs.
- **Contextual Analysis**: Your analysis must extend beyond just the changed lines. Consider the entire function, method, or code block provided in the diff to understand its purpose, interactions, and potential flaws.
- **Strict Code Snippet Copy**: The 'code_snippet' field MUST BE AN EXACT, UNMODIFIED COPY of the original problematic code lines from the provided diff. Do NOT add, remove, reformat, or auto-correct any part of the 'code_snippet'. Its purpose is solely to point precisely to the original code where the issue resides.
- **Comprehensive Suggestions**: For every single issue identified, you MUST provide a clear, actionable 'suggestion' for improvement.
- **Separate Proposed Code Snippet**: If the suggestion involves code changes, the 'proposed_code_snippet' field MUST contain the full proposed code block. This code should be properly formatted and ready for direct use. If there is no code change suggested, this field should be an empty string "".
- **Detailed Explanations**: For each issue, provide a clear, concise, and thorough 'description' of the problem, its root cause, and its potential impact (e.g., data corruption, performance degradation, security breach, maintainability burden). In the 'suggestion' field, explain the 'why' and 'benefit' of your proposed change, including the rationale for any new code.
- **No External References**: Do not reference files, functions, or concepts that are not explicitly present within the provided diff's context.
- **Focus on Provided Code**: All identified issues and suggestions must be directly observable or logically inferable from the code provided in the diff.

Your JSON response must follow this exact structure:
{
  "overall_summary": "A brief, highly critical summary of the changes and your general impression. Explicitly state the overall code quality and the density of issues found.",
  "highlights": [
    "List ALL genuine good practices, significant improvements made in the diff, or existing strong points in the code. Each highlight should follow this format: <Category>: <Description of change> in <function or file>. Use concise, action-based phrases. Avoid vague or narrative descriptions. Examples: - Dead Code Removal: Removed unused 'calculate' function from dead_code.py."
  ],
  "issues": [
    {
      "severity": "Assign the most appropriate severity tag from: [INFO], [MINOR], [MAJOR], [CRITICAL]. Use [INFO] **liberally** for even very minor style, readability, micro-optimizations, or best practice suggestions. Use [CRITICAL] for immediate, show-stopping bugs, severe security vulnerabilities, or guaranteed crashes/resource exhaustion.",
      "title": "A concise and highly descriptive title for the issue (e.g., 'Missing Input Type/Range Validation', 'Broad Exception Catch Masking Errors', 'Potential Floating-Point Imprecision', 'Unbounded Computation for Large Exponents', 'Inconsistent Naming Convention').",
      "description": "A detailed explanation of the problem, its root cause, and its potential impact (e.g., 'This can lead to a denial-of-service attack due to unbounded computation time when Y is large.'). Be explicit about why it's an issue and the real-world consequences.",
      "suggestion": "A clear, actionable recommendation for improvement, explaining the benefits of the suggested change and how it effectively addresses the identified issue. Refer to the 'proposed_code_snippet' for implementation details. Include best practices, alternative design patterns, or library recommendations.",
      "file": "The file name containing the issue (e.g., 'my_module.py').",
      "line": "The starting line number of the issue in the original code (NOT the diff line number).",
      "code_snippet": "This field MUST BE AN EXACT COPY of the original code snippet (from the diff) that contains the issue. DO NOT add, remove, reformat, or auto-correct code snippets."
      "proposed_code_snippet": "The full proposed code block to fix the issue, ready for direct use. If no code change is suggested, this field should be an empty string ''."
    }
  ]
}
Respond with a single valid JSON object only. Do not include Markdown, code blocks, backticks, or any additional formatting outside of the JSON object itself.

Here is the code diff:

${diff}`;
}

async function requestAzure(prompt) {
  console.log("Using Azure OpenAI...");
  const { endpoint, deployment, key } = CONFIG.azure;
  const res = await axios.post(
    `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2025-01-01-preview`,
    {
      messages: [
        { role: "system", content: "You are a professional code reviewer." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 8192,
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
    const body = `#### ${priority}\n\n**Issue: ${issue.title}**  \n${issue.description}  \n\n**Suggestion:**  \n${issue.suggestion} \n\n

    ${issue.proposed_code_snippet ? `\n\`\`\`js\n${issue.proposed_code_snippet}\n\`\`\`` : ''}`;


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