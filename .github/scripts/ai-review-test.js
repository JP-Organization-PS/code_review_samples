const axios = require('axios');
const { execSync } = require('child_process');
const github = require('@actions/github');
const fs = require('fs');
const parseDiff = require('parse-diff'); 
const similarity = require('string-similarity');

// --- Constants ---
const TOKEN_LIMIT = 16384;
const MAX_LINES_PER_CHUNK = 150;
const API_VERSION_AZURE = '2025-01-01-preview';
const MAX_RETRIES = 3; // Maximum number of retry attempts
const RETRY_DELAY_MS = 2000; // Initial delay in milliseconds (2 seconds)

const GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH;
const GITHUB_BASE_REF = process.env.GITHUB_BASE_REF;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;

const AI_MODEL = process.env.AI_MODEL || 'gemini';

const AZURE_CONFIG = {
  key: process.env.AZURE_OPENAI_KEY,
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
};

const GEMINI_CONFIG = {
  key: process.env.GEMINI_API_KEY,
  endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
};

// --- Utility Functions ---

/**
 * Estimates the number of tokens for a given text.
 * @param {string} text - The input text.
 * @returns {number} - The estimated token count.
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// ==================================================================================
// =================== THIS IS THE SPECIAL DEBUGGING FUNCTION ===================
// ==================================================================================
function normalizeLine(line) {
  return line
    .trim()
    .replace(/^[\s+-]/, '') // Removes diff prefixes
    .replace(/\s+/g, ' ');   // Collapses internal whitespace
}

/**
 * Determines the line number of a code snippet by first attempting an exact
 * match (with debugging) and then falling back to fuzzy matching.
 * @param {string} diffText - The full diff text.
 * @param {string} filePath - The path of the file where the snippet is located.
 * @param {string} codeSnippet - The code snippet from the AI.
 * @returns {{start: number, end: number}|null}
 */
function matchSnippetFromDiff(diffText, filePath, codeSnippet) {
  const SIMILARITY_THRESHOLD = 0.85; // Match if strings are 85% similar

  const parsedFiles = parseDiff(diffText);
  const targetFile = parsedFiles.find(file => file.to === filePath || file.from === filePath);

  if (!targetFile) {
    return null;
  }

  const snippetLines = codeSnippet.trim().split('\n');
  const normalizedSnippetLines = snippetLines.map(normalizeLine);
  if (normalizedSnippetLines.length === 0 || normalizedSnippetLines.every(l => l === '')) {
    return null;
  }

  // --- STAGE 1: Attempt an Exact Match (with Debugging) ---
  for (const chunk of targetFile.chunks) {
    for (let i = 0; i <= chunk.changes.length - snippetLines.length; i++) {
      const window = chunk.changes.slice(i, i + snippetLines.length);
      const normalizedWindowLines = window.map(c => normalizeLine(c.content));

      let allLinesMatch = true;
      for (let j = 0; j < normalizedSnippetLines.length; j++) {
        if (normalizedSnippetLines[j] !== normalizedWindowLines[j]) {
          allLinesMatch = false;
          // *** EXACT MATCH DEBUGGING LOGIC ***
          // console.log('\n--- EXACT MATCH FAILED ---');
          // console.log(`FILE: ${filePath}`);
          // console.log(`DETAILS: Line ${j + 1} of the snippet did not match.`);
          // console.log('AI SNIPPET (Normalized):  ', JSON.stringify(normalizedSnippetLines[j]));
          // console.log('GIT DIFF   (Normalized):', JSON.stringify(normalizedWindowLines[j]));
          // console.log('--- END MISMATCH ---\n');
          break; // Stop checking this window
        }
      }

      if (allLinesMatch) {
        console.log(`✅ Found exact match for snippet in ${filePath}`);
        const firstAddedChange = window.find(c => c.add);
        if (firstAddedChange) {
          return { start: firstAddedChange.ln, end: window[window.length - 1].ln || firstAddedChange.ln };
        }
      }
    }
  }

  // --- STAGE 2: Fallback to Fuzzy Matching ---
  console.log(`- Exact match failed. Attempting fuzzy match for snippet in ${filePath}...`);
  const snippetText = normalizedSnippetLines.join('\n');

  for (const chunk of targetFile.chunks) {
    for (let i = 0; i <= chunk.changes.length - snippetLines.length; i++) {
      const window = chunk.changes.slice(i, i + snippetLines.length);
      const windowText = window.map(c => normalizeLine(c.content)).join('\n');
      
      const matchScore = similarity.compareTwoStrings(snippetText, windowText);

      if (matchScore >= SIMILARITY_THRESHOLD) {
        console.log(`✅ Found fuzzy match with score ${matchScore.toFixed(2)} in ${filePath}`);
        const firstAddedChange = window.find(c => c.add);
        if (firstAddedChange) {
          return { start: firstAddedChange.ln, end: window[window.length - 1].ln || firstAddedChange.ln };
        }
      } 
      // *** FUZZY MATCH DEBUGGING: Log "near misses" ***
      else if (matchScore > 0.6) { // Log any score over 60%
        console.log('\n--- POTENTIAL FUZZY MATCH (BELOW THRESHOLD) ---');
        console.log(`FILE: ${filePath}`);
        console.log(`DETAILS: Match score was ${matchScore.toFixed(2)} (Threshold is ${SIMILARITY_THRESHOLD})`);
        console.log('--- END POTENTIAL MATCH ---\n');
      }
    }
  }

  console.warn(`❌ No exact or fuzzy match found for snippet in file: ${filePath}`);
  return null;
}

// ==================================================================================
// ================= END OF SPECIAL DEBUGGING FUNCTION ==================
// ==================================================================================


/**
 * Parses a diff string into an array of file objects.
 * @param {string} diffText - The raw diff string.
 * @returns {Array} - Array of parsed file objects.
 */
function parseGitDiff(diffText) {
  return parseDiff(diffText);
}

/**
 * Splits a parsed file into smaller, token-aware chunks.
 * @param {object} parsedFile - A file object parsed by 'parse-diff'.
 * @param {number} promptTokens - The estimated token count of the base prompt.
 * @param {number} tokenLimit - The maximum total tokens for a request.
 * @returns {Array<object>} - Array of chunk objects with filePath and chunkText.
 */
function splitLargeFileChunks(parsedFile, promptTokens, tokenLimit = TOKEN_LIMIT) {
  const chunks = [];
  const maxChunkTokens = tokenLimit - promptTokens - 500; // 500 tokens buffer for safety

  let currentChunkLines = [];
  let currentChunkTokens = 0;
  let lastChunkHeader = '';

  for (const chunk of parsedFile.chunks) {
    const chunkHeader = `@@ ${chunk.content} @@`;
    lastChunkHeader = chunkHeader; // Keep track of the latest header

    for (const change of chunk.changes) {
      const line = change.content;
      const lineTokens = estimateTokens(line);

      if (currentChunkTokens + lineTokens > maxChunkTokens && currentChunkLines.length > 0) {
        chunks.push({
          filePath: parsedFile.to || parsedFile.from,
          chunkText: [chunkHeader, ...currentChunkLines].join('\n'),
        });
        currentChunkLines = [];
        currentChunkTokens = 0;
      }
      
      currentChunkLines.push(line);
      currentChunkTokens += lineTokens;
    }
  }

  // FIX: Add the last chunk with its corresponding header
  if (currentChunkLines.length > 0) {
    chunks.push({
      filePath: parsedFile.to || parsedFile.from,
      chunkText: [lastChunkHeader, ...currentChunkLines].join('\n'), // Use the last seen header
    });
  }

  return chunks;
}

/**
 * Splits the entire diff by individual files, preparing them for AI processing.
 * @param {string} diffText - The full Git diff text.
 * @returns {Array<object>} - Array of file objects, each with its diff and parsed structure.
 */
function splitDiffByFileChunks(diffText) {
  const parsedFiles = parseGitDiff(diffText);
  const fileChunks = [];

  for (const file of parsedFiles) {
    const fileDiffLines = [];
    for (const chunk of file.chunks) {
      const chunkHeader = `@@ ${chunk.content} @@`;
      const chunkLines = chunk.changes.map(c => c.content);
      fileDiffLines.push(chunkHeader, ...chunkLines);
    }
    fileChunks.push({
      filePath: file.to || file.from,
      diff: fileDiffLines.join('\n'),
      parsedFile: file // Include the parsed file for potential further processing
    });
  }
  return fileChunks;
}



/**
 * Builds the prompt for the AI model.
 * @param {string} diff - The code diff chunk.
 * @returns {string} - The constructed prompt.
 */
function buildPrompt(diff) {
  return `You are an **extremely meticulous, highly critical, and relentlessly exhaustive expert software engineer and code reviewer**. Your mission: mission is to conduct a forensic analysis of the provided code. Your goal is to identify and report *every single possible issue, flaw, anti-pattern, potential bug, vulnerability, inefficiency, design imperfection, or area for improvement*, no matter how minor, subtle, or seemingly insignificant.

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
- **Concurrency & Thread Safety**: Identify **race conditions, deadlocks, livelocks, improper use of locks/mutexes, atomicity issues**, and potential for data corruption in multi-threaded or asynchronous environments.
- **Third-Party Library/Dependency Risks**: Assess the usage of external libraries for **known vulnerabilities in specific versions, dependency confusion, or supply chain attack vectors**.
- **Localization & Internationalization (I18n)**: Check for **hardcoded strings, incorrect character encodings, or non-locale-aware date/time/currency handling**.

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

/**
 * Calls the specified AI model with the given prompt, with a retry mechanism.
 * @param {string} modelName - The name of the AI model ('azure' or 'gemini').
 * @param {string} prompt - The prompt to send to the AI.
 * @returns {Promise<object>} - The parsed JSON response from the AI.
 * @throws {Error} If the API call fails after all retries.
 */

async function callAIModel(modelName, prompt, promptTokens) {
  console.log(`Using ${modelName.toUpperCase()} model...`);
  const availableOutputTokens = Math.max(1024, TOKEN_LIMIT - promptTokens - 500); // Safety buffer
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let res;
      if (modelName === 'azure') {
        const { endpoint, deployment, key } = AZURE_CONFIG;
        res = await axios.post(
          `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${API_VERSION_AZURE}`,
          {
            messages: [{ role: "system", content: "You are a professional code reviewer." }, { role: "user", content: prompt }],
            temperature: 0.3,
            max_tokens: availableOutputTokens,
          },
          { headers: { 'api-key': key, 'Content-Type': 'application/json' } }
        );
        return res.data.choices?.[0]?.message?.content?.trim();
      } else if (modelName === 'gemini') {
        const { endpoint } = GEMINI_CONFIG;
        res = await axios.post(
          endpoint,
          {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, topP: 0.9, maxOutputTokens: availableOutputTokens },
          },
          { headers: { 'Content-Type': 'application/json' } }
        );
        return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      } else {
        throw new Error(`Unsupported AI model: ${modelName}`);
      }
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt} failed for ${modelName} model:`, error.message);
      if (error.response && error.response.status >= 400 && error.response.status < 500) {
        console.error(`Client error (${error.response.status}), not retrying.`);
        break;
      }
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  console.error(`All ${MAX_RETRIES} retries failed for ${modelName} AI model.`);
  if (lastError?.response) {
    console.error(`Final Status: ${lastError.response.status}`);
    console.error(`Final Data: ${JSON.stringify(lastError.response.data)}`);
  }
  throw new Error(`Failed to get response from ${modelName} AI model after ${MAX_RETRIES} attempts.`);
}

// --- Git and GitHub Interaction Functions ---

/**
 * Retrieves the Git diff and changed files for a pull request context.
 * Exits if not a PR or if no changes are detected.
 * @returns {{reviewType: string, diff: string, changedFiles: string[]}} - Git diff information.
 */
function getGitDiff() {
  try {
    if (!GITHUB_BASE_REF) {
      console.log("Not a pull request context (GITHUB_BASE_REF not set). Skipping AI review.");
      process.exit(0);
    }

    const event = JSON.parse(fs.readFileSync(GITHUB_EVENT_PATH, 'utf8'));
    const action = event.action;

    if (action !== 'opened') {
      console.log(`PR action is '${action}' — skipping AI review (only run on 'opened').`);
      process.exit(0);
    }

    console.log(`Detected PR action: ${action}`);
    console.log(`Running full diff against base branch: ${GITHUB_BASE_REF}`);

    // Fetch latest base branch to ensure accurate diff
    execSync(`git fetch origin ${GITHUB_BASE_REF}`, { stdio: 'inherit' });

    // Full diff between base branch and HEAD
    const fullDiff = execSync(`git diff origin/${GITHUB_BASE_REF}...HEAD`, { encoding: 'utf-8', stdio: 'pipe' }).toString();

    const changedFiles = execSync(`git diff --name-only origin/${GITHUB_BASE_REF}...HEAD`, { encoding: 'utf-8', stdio: 'pipe' })
      .split('\n')
      .filter(Boolean);

    if (!fullDiff.trim() || changedFiles.length === 0) {
      console.log("No changes detected in the PR or no relevant files. Skipping AI review.");
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

/**
 * Generates the Markdown summary for the GitHub PR comment.
 * @param {string[]} overallSummaries - Array of overall summaries from AI responses.
 * @param {Set<string>} allHighlights - Set of all highlights from AI responses.
 * @param {Array<object>} filteredIssues - Array of issues relevant to changed files.
 * @returns {string} - The formatted Markdown summary.
 */
function generateReviewSummary(overallSummaries, allHighlights, filteredIssues) {
  let summary = `### AI Code Review Summary\n\n**📝 Overall Summary:** \n${overallSummaries.join("\n\n")}\n\n**✅ Highlights:** \n${[...allHighlights].map(p => `- ${p}`).join('\n')}`;

  if (filteredIssues.length) {
    summary += `\n\n<details>\n<summary>⚠️ <strong>Detected Issues (${filteredIssues.length})</strong> — Click to expand</summary><br>\n`;
    for (const issue of filteredIssues) {
      let emoji = '🟢';
      let severityLabel = 'Low Priority';

      switch (issue.severity) {
        case 'CRITICAL': emoji = '🔴'; severityLabel = 'Critical Priority'; break;
        case 'MAJOR': emoji = '🔴'; severityLabel = 'High Priority'; break;
        case 'MINOR': emoji = '🟠'; severityLabel = 'Medium Priority'; break;
        case 'INFO': emoji = '🔵'; severityLabel = 'Informational'; break;
        default: break;
      }

      summary += `\n- <details>\n  <summary><strong>${emoji} ${issue.title}</strong> <em>(${severityLabel})</em></summary>\n\n  **📁 File:** \`${issue.file}\` \n  **🔢 Line:** ${issue.line || 'N/A'}\n\n  **📝 Description:** \n  ${issue.description}\n\n  **💡 Suggestion:** \n  ${issue.suggestion}\n  </details>`;
    }
    summary += `\n</details>`;
  }
  return summary;
}

/**
 * Posts the overall review summary to the GitHub Pull Request.
 * @param {object} octokit - GitHub Octokit instance.
 * @param {string} owner - Repository owner.
 * @param {string} repo - Repository name.
 * @param {number} prNumber - Pull Request number.
 * @param {string} commitId - Commit SHA to associate the review with.
 * @param {string} summary - The Markdown summary to post.
 */
async function postReviewSummary(octokit, owner, repo, prNumber, commitId, summary) {
    try {
        await octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number: prNumber,
            commit_id: commitId,
            event: 'COMMENT',
            body: summary,
        });
        console.log('Successfully posted overall review summary.');
    } catch (error) {
        console.error('Failed to post overall review summary:', error.message);
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error(`Data: ${JSON.stringify(error.response.data)}`);
        }
    }
}

/**
 * Posts individual review comments for each issue to the GitHub Pull Request.
 * @param {object} octokit - GitHub Octokit instance.
 * @param {string} owner - Repository owner.
 * @param {string} repo - Repository name.
 * @param {number} prNumber - Pull Request number.
 * @param {string} commitId - Commit SHA to associate the comments with.
 * @param {Array<object>} issues - Array of issues to comment on.
 * @param {string} fullDiff - The complete Git diff, used for snippet matching.
 */
async function postIssueComments(octokit, owner, repo, prNumber, commitId, issues, fullDiff) {
  for (const issue of issues) {
    const snippetLocation = matchSnippetFromDiff(fullDiff, issue.file, issue.code_snippet);
    if (!snippetLocation) {
      console.warn(`Could not find snippet location for issue in ${issue.file}. Skipping inline comment.`);
      continue;
    }

    const priority = issue.severity === 'CRITICAL' || issue.severity === 'MAJOR' ? '🔴 High Priority' :
      issue.severity === 'MINOR' ? '🟠 Medium Priority' :
        issue.severity === 'INFO' ? '🔵 Informational' : '🟢 Low Priority';

    const body = `#### ${priority}\n\n**Issue: ${issue.title}** \n${issue.description} \n\n**Suggestion:** \n${issue.suggestion} \n\n` +
      `${issue.proposed_code_snippet ? `\n\`\`\`\n${issue.proposed_code_snippet}\n\`\`\`\n` : ''}`;

    try {
      await octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitId,
        path: issue.file,
        line: snippetLocation.start, // Line number where the comment should appear
        side: 'RIGHT', // 'RIGHT' for the head commit, 'LEFT' for the base commit
        body,
      });
      console.log(`Posted inline comment for issue: "${issue.title}" in ${issue.file}:${snippetLocation.start}`);
    } catch (commentError) {
      console.error(`Failed to post inline comment for issue "${issue.title}" in ${issue.file}:`, commentError.message);
      // Log more details for Axios errors
      if (commentError.response) {
        console.error(`Status: ${commentError.response.status}`);
        console.error(`Data: ${JSON.stringify(commentError.response.data)}`);
      }
    }
  }
}


// --- Main Review Logic ---
// --- Main Review Logic ---

async function reviewCode() {
  const { diff: fullDiff, changedFiles } = getGitDiff();
  console.log("Starting review for the following changed files:", changedFiles);
  const fileChunks = splitDiffByFileChunks(fullDiff);

  const allIssues = [];
  const allHighlights = new Set();
  const overallSummaries = [];

  // Estimate the token count of the base prompt itself.
  const basePromptTokens = estimateTokens(buildPrompt(""));

  for (const file of fileChunks) {
    const { filePath, diff: fileDiffText, parsedFile } = file;
    console.log(`\n---`);
    console.log(`📄 Reviewing file: ${filePath}`);

    const diffTokens = estimateTokens(fileDiffText);
    let chunksToProcess;

    if (basePromptTokens + diffTokens > TOKEN_LIMIT) {
      chunksToProcess = splitLargeFileChunks(parsedFile, basePromptTokens, TOKEN_LIMIT);
      console.log(`   - ❗ File diff is large (${diffTokens} tokens), splitting into ${chunksToProcess.length} token-aware chunks.`);
    } else {
      chunksToProcess = [{ filePath, chunkText: fileDiffText }];
      console.log(`   - ✅ Reviewing entire file diff (${diffTokens} tokens) as a single chunk.`);
    }

    // Use .entries() to get the index of the chunk
    for (const [index, { filePath: chunkFilePath, chunkText }] of chunksToProcess.entries()) {
      if (chunksToProcess.length > 1) {
        console.log(`     - 쪼개기 Processing chunk ${index + 1} of ${chunksToProcess.length}...`);
      }

      const prompt = buildPrompt(chunkText);
      let reviewRaw;
      try {
        reviewRaw = await callAIModel(AI_MODEL, prompt);
      } catch (error) {
        console.error(`Skipping AI review for chunk in ${chunkFilePath} due to API error.`);
        continue;
      }

      let parsedReview;
      try {
        const cleaned = reviewRaw.replace(/```json|```/g, "").trim();
        parsedReview = JSON.parse(cleaned);
      } catch (e) {
        console.error(`Failed to parse AI JSON response for file ${chunkFilePath}:`, e.message);
        console.error('Raw AI response:', reviewRaw);
        continue;
      }

      // Only take the summary from the FIRST chunk of a file
      if (parsedReview.overall_summary && index === 0) {
        overallSummaries.push(parsedReview.overall_summary);
      }
      if (parsedReview.highlights) {
        parsedReview.highlights.forEach(h => allHighlights.add(h));
      }
      if (parsedReview.issues?.length) {
        allIssues.push(...parsedReview.issues.map(issue => ({ ...issue, file: chunkFilePath })));
      }
    }
    console.log(`--- Finished reviewing file: ${filePath}`);
  }

  const octokit = github.getOctokit(GITHUB_TOKEN);
  const [owner, repo] = GITHUB_REPOSITORY.split('/');
  const prNumber = github.context.payload.pull_request?.number ||
                   parseInt(process.env.GITHUB_REF.match(/refs\/pull\/(\d+)\/merge/)?.[1]);

  if (!prNumber) {
    console.error("Could not determine PR number. Exiting.");
    process.exit(1);
  }

  const commitId = github.context.payload.pull_request?.head?.sha;
  if (!commitId) {
    console.error("Could not determine commit ID. Exiting.");
    process.exit(1);
  }

  const filteredIssues = allIssues.filter(issue => changedFiles.includes(issue.file));

  console.log('--- Collected Overall Summaries Before Generation ---');
  console.log(JSON.stringify(overallSummaries, null, 2));
  console.log('-----------------------------------');

  const summaryMarkdown = generateReviewSummary(overallSummaries, allHighlights, filteredIssues);
  await postReviewSummary(octokit, owner, repo, prNumber, commitId, summaryMarkdown);

  console.log('--- Full Overall Summary Markdown Being Posted ---');
  console.log(summaryMarkdown);
  console.log('-----------------------------------');

  await postIssueComments(octokit, owner, repo, prNumber, commitId, filteredIssues, fullDiff);

  console.log('AI Code Review complete.');
}

// Execute the main review function
reviewCode().catch(error => {
  console.error("An unhandled error occurred during the AI code review:", error);
  process.exit(1);
});