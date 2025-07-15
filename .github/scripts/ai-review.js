const axios = require('axios');
const { execSync } = require('child_process');
const github = require('@actions/github');
const fs = require('fs');
const parseDiff = require('parse-diff');
const similarity = require('string-similarity');
const Parser = require('tree-sitter');

// --- Constants ---
const TOKEN_LIMIT = 16384;
const API_VERSION_AZURE = '2025-01-01-preview';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

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
    endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent`, // Key removed from URL
};

/**
 * Universal Language Configuration for Tree-sitter.
 */
const LANGUAGE_CONFIG = {
    javascript: {
        extensions: ['.js', '.jsx', '.mjs', '.cjs'],
        module: 'tree-sitter-javascript',
        query: `[(function_declaration) @function (function) @function (method_definition) @function (arrow_function) @function]`,
    },
    typescript: {
        extensions: ['.ts', '.tsx'],
        module: { 'typescript': require('tree-sitter-typescript').typescript },
        query: `[(function_declaration) @function (function) @function (method_definition) @function (arrow_function) @function]`,
    },
    python: {
        extensions: ['.py'],
        module: 'tree-sitter-python',
        query: `[(function_definition) @function (class_definition) @function]`,
    },
    java: {
        extensions: ['.java'],
        module: 'tree-sitter-java',
        query: `[(class_declaration) @function (interface_declaration) @function (enum_declaration) @function]`,
    },
    csharp: {
        extensions: ['.cs'],
        module: 'tree-sitter-c-sharp',
        query: `[(class_declaration) @function (interface_declaration) @function (struct_declaration) @function (enum_declaration) @function (record_declaration) @function (delegate_declaration) @function (method_declaration) @function]`,
    },
    go: {
        extensions: ['.go'],
        module: 'tree-sitter-go',
        query: `(function_declaration) @function`,
    },
    rust: {
        extensions: ['.rs'],
        module: 'tree-sitter-rust',
        query: `[(function_item) @function (macro_definition) @function (impl_item) @function (trait_item) @function]`,
    },
    php: {
        extensions: ['.php'],
        module: 'tree-sitter-php',
        query: `[(function_definition) @function (class_declaration) @function (trait_declaration) @function]`,
    },
    ruby: {
        extensions: ['.rb'],
        module: 'tree-sitter-ruby',
        query: `[(method) @function (class) @function (module) @function (singleton_method) @function]`,
    },
    c: {
        extensions: ['.c', '.h'],
        module: 'tree-sitter-c',
        query: `(function_definition) @function`,
    },
    cpp: {
        extensions: ['.cpp', '.hpp', '.cc', '.hh', '.cxx', '.hxx'],
        module: 'tree-sitter-cpp',
        query: `[(function_definition) @function (class_specifier) @function (template_declaration) @function]`,
    }
};

// --- Utility & Chunking Functions ---

/**
 * Estimates the number of tokens for a given text based on a simple character count heuristic.
 * @param {string} text The input text to estimate tokens for.
 * @returns {number} The estimated token count.
 */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

/**
 * Normalizes a line of code or diff by removing prefixes and collapsing whitespace.
 * @param {string} line The line to normalize.
 * @returns {string} The normalized line.
 */
function normalizeLine(line) {
    return line.trim().replace(/^[\s+-]/, '').replace(/\s+/g, ' ');
}

/**
 * Finds the location of a code snippet within a diff using fuzzy matching.
 * @param {string} diffText The entire git diff.
 * @param {string} filePath The path of the file to search within.
 * @param {string} codeSnippet The code snippet provided by the AI.
 * @returns {{start: number, end: number}|null} The start and end line numbers or null if not found.
 */
function matchSnippetFromDiff(diffText, filePath, codeSnippet) {
    const SIMILARITY_THRESHOLD = 0.85;
    const parsedFiles = parseDiff(diffText);
    const targetFile = parsedFiles.find(file => file.to === filePath || file.from === filePath);
    if (!targetFile) return null;

    if (!codeSnippet || typeof codeSnippet !== 'string') {
        console.warn(`Invalid code snippet provided for file: ${filePath}`);
        return null;
    }

    const snippetLines = codeSnippet.trim().split('\n');
    const normalizedSnippetLines = snippetLines.map(normalizeLine);
    if (normalizedSnippetLines.length === 0 || normalizedSnippetLines.every(l => l === '')) return null;

    // FIX: The missing line is added here.
    const snippetText = normalizedSnippetLines.join('\n');

    for (const chunk of targetFile.chunks) {
        for (let i = 0; i <= chunk.changes.length - snippetLines.length; i++) {
            const window = chunk.changes.slice(i, i + snippetLines.length);
            const windowText = window.map(c => normalizeLine(c.content)).join('\n');
            if (similarity.compareTwoStrings(snippetText, windowText) >= SIMILARITY_THRESHOLD) {
                console.log(`✅ Found fuzzy match for snippet in ${filePath}`);
                const firstAddedChange = window.find(c => c.add);
                if (firstAddedChange) {
                    const lastChange = window[window.length - 1];
                    // A normal change has both, an add has only 'ln', a delete has only 'ln2'
                    const endLine = lastChange.add ? lastChange.ln : (lastChange.del ? lastChange.ln2 : lastChange.ln);
                    return { start: firstAddedChange.ln, end: endLine || firstAddedChange.ln };
                }
            }
        }
    }
    console.warn(`❌ No match found for snippet in file: ${filePath}`);

    console.log("\n--- Snippet that failed to match ---\n");
    console.log(codeSnippet);
    console.log("\n------------------------------------\n");
    return null;
}

/**
 * (Level 2) Chunks a large file by its functions/classes using Tree-sitter for multi-language parsing.
 * @param {string} filePath The path to the file.
 * @param {object} parsedFile The file object from `parse-diff`.
 * @param {number} promptTokens The token count of the base prompt.
 * @param {number} tokenLimit The AI model's token limit.
 * @returns {object[]|null} An array of function-based chunks or null if parsing fails or is not supported.
 */
function chunkByFunction(filePath, parsedFile, promptTokens, tokenLimit) {
    const fileExtension = '.' + filePath.split('.').pop();
    const lang = Object.keys(LANGUAGE_CONFIG).find(key => LANGUAGE_CONFIG[key].extensions.includes(fileExtension));

    if (!lang) {
        console.log(`   - File type ${fileExtension} is not configured for function chunking. Skipping.`);
        return null;
    }

    const config = LANGUAGE_CONFIG[lang];
    try {
        const sourceCode = execSync(`git show HEAD:${filePath}`, { encoding: 'utf-8' }).toString();
        const parser = new Parser();
        
        let languageModule;
        if (typeof config.module === 'object') {
            parser.setLanguage(config.module[Object.keys(config.module)[0]]);
        } else {
            languageModule = require(config.module);
            parser.setLanguage(languageModule);
        }

        const tree = parser.parse(sourceCode);
        const query = new Parser.Query(parser.getLanguage(), config.query);
        const matches = query.captures(tree.rootNode);

        const changedLines = new Set();
        parsedFile.chunks.forEach(chunk => chunk.changes.forEach(change => changedLines.add(change.add ? change.ln : change.ln2)));

        const functionChunks = [];
        const maxChunkTokens = tokenLimit - promptTokens - 500;

        for (const match of matches) {
            const node = match.node;
            const startLine = node.startPosition.row + 1;
            const endLine = node.endPosition.row + 1;
            if (Array.from(changedLines).some(line => line >= startLine && line <= endLine)) {
                const functionSource = node.text;
                if (estimateTokens(functionSource) > maxChunkTokens) {
                    throw new Error(`Function at line ${startLine} is too large to process.`);
                }
                functionChunks.push({ type: 'function', chunkText: functionSource, filePath: filePath, startLine: startLine });
            }
        }
        const uniqueFunctionChunks = Array.from(new Map(functionChunks.map(c => [c.startLine, c])).values());
        return uniqueFunctionChunks.length > 0 ? uniqueFunctionChunks : null;
    } catch (error) {
        console.warn(`   - ⚠️ Failed to chunk ${filePath} by function: ${error.message}`);
        if (error.code === 'MODULE_NOT_FOUND') {
            console.warn(`   - HINT: Did you install the grammar? Try 'npm install ${config.module}'`);
        }
        return null;
    }
}

/**
 * (Level 3) Chunks a large diff into smaller pieces based on token limits as a fallback.
 * @param {object} parsedFile The file object from `parse-diff`.
 * @param {number} promptTokens The token count of the base prompt.
 * @param {number} tokenLimit The AI model's token limit.
 * @returns {object[]} An array of diff-based chunks.
 */
function splitLargeFileChunks(parsedFile, promptTokens, tokenLimit) {
    const chunks = [];
    const maxChunkTokens = tokenLimit - promptTokens - 500;
    let currentChunkLines = [];
    let currentChunkTokens = 0;
    let lastChunkHeader = '';

    for (const chunk of parsedFile.chunks) {
        const chunkHeader = `@@ ${chunk.content} @@`;
        lastChunkHeader = chunkHeader;
        for (const change of chunk.changes) {
            const line = change.content;
            const lineTokens = estimateTokens(line);
            if (currentChunkTokens + lineTokens > maxChunkTokens && currentChunkLines.length > 0) {
                chunks.push({ type: 'diff', filePath: parsedFile.to || parsedFile.from, chunkText: [chunkHeader, ...currentChunkLines].join('\n') });
                currentChunkLines = [];
                currentChunkTokens = 0;
            }
            currentChunkLines.push(line);
            currentChunkTokens += lineTokens;
        }
    }

    if (currentChunkLines.length > 0) {
        chunks.push({ type: 'diff', filePath: parsedFile.to || parsedFile.from, chunkText: [lastChunkHeader, ...currentChunkLines].join('\n') });
    }
    return chunks;
}

/**
 * (Level 1) Splits a raw git diff into chunks, one for each file.
 * @param {string} diffText The entire raw git diff.
 * @returns {object[]} An array of objects, each representing a changed file.
 */
function splitDiffByFileChunks(diffText) {
    const parsedFiles = parseDiff(diffText);
    return parsedFiles.map(file => ({
        filePath: file.to || file.from,
        diff: `--- a/${file.from}\n+++ b/${file.to}\n` + file.chunks.map(chunk => `@@ ${chunk.content} @@\n` + chunk.changes.map(c => c.content).join('\n')).join('\n'),
        parsedFile: file,
    }));
}


// --- Prompt Engineering ---

const PROMPT_BASE = `You are an extremely meticulous, highly critical, and relentlessly exhaustive expert software engineer and code reviewer. Your mission: mission is to conduct a forensic analysis of the provided code. Your goal is to identify and report *every single possible issue, flaw, anti-pattern, potential bug, vulnerability, inefficiency, design imperfection, or area for improvement*, no matter how minor, subtle, or seemingly insignificant.

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
Respond with a single valid JSON object only. Do not include Markdown, code blocks, backticks, or any additional formatting outside of the JSON object itself.`;

/**
 * Builds the AI prompt for reviewing a code diff.
 * @param {string} diff The code diff to be reviewed.
 * @returns {string} The complete prompt for the AI model.
 */
function buildDiffReviewPrompt(diff) {
    return `${PROMPT_BASE}\n\nAnalyze the following code diff. The 'code_snippet' you return must be an exact copy of lines from the diff.\n\nHere is the code diff:\n\n${diff}`;
}

/**
 * Builds the AI prompt for reviewing the full source code of a function.
 * @param {string} functionCode The full source code of the function to be reviewed.
 * @returns {string} The complete prompt for the AI model.
 */
function buildFunctionReviewPrompt(functionCode) {
    return `${PROMPT_BASE}\n\nInstead of a diff, you are provided with the complete source code of a function that was modified in a pull request. Analyze the entire function for any potential issues. The 'code_snippet' you return must be an exact copy of lines from the provided function code.\n\nHere is the full function code:\n\`\`\`\n${functionCode}\n\`\`\`\n`;
}


// --- AI & GitHub Interaction ---

/**
 * Calls the specified AI model with a prompt and handles retries.
 * @param {string} modelName The name of the model to use ('azure' or 'gemini').
 * @param {string} prompt The complete prompt to send to the model.
 * @param {number} promptTokens The estimated token count of the prompt.
 * @returns {Promise<string|undefined>} The AI's response as a string, or undefined if all retries fail.
 */
async function callAIModel(modelName, prompt, promptTokens) {
    console.log(`Using ${modelName.toUpperCase()} model...`);
    const availableOutputTokens = Math.max(1024, TOKEN_LIMIT - promptTokens - 500);
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            let res;
            if (modelName === 'azure') {
                const { endpoint, deployment, key } = AZURE_CONFIG;
                res = await axios.post(`${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${API_VERSION_AZURE}`,
                    { messages: [{ role: "system", content: "You are a professional code reviewer." }, { role: "user", content: prompt }], temperature: 0.3, max_tokens: availableOutputTokens },
                    { headers: { 'api-key': key, 'Content-Type': 'application/json' } }
                );
                return res.data.choices?.[0]?.message?.content?.trim();
            } else if (modelName === 'gemini') {
                const { endpoint, key } = GEMINI_CONFIG;
                res = await axios.post(`${endpoint}?key=${key}`,
                    { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, topP: 0.9, maxOutputTokens: availableOutputTokens } },
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
    throw new Error(`Failed to get response from ${modelName} AI model after ${MAX_RETRIES} attempts.`);
}

/**
 * Gets the git diff for the current pull request context.
 * @returns {{diff: string, changedFiles: string[]}} An object containing the full diff and a list of changed file paths.
 */
function getGitDiff() {
    try {
        if (!GITHUB_BASE_REF) {
            console.log("Not a pull request context. Skipping AI review.");
            process.exit(0);
        }
        const event = JSON.parse(fs.readFileSync(GITHUB_EVENT_PATH, 'utf8'));
        const allowedActions = ['opened', 'synchronize'];
        if (!allowedActions.includes(event.action)) {
            console.log(`PR action is '${event.action}'. Skipping AI review.`);
            process.exit(0);
        }

        console.log(`Fetching base branch ${GITHUB_BASE_REF} for diff...`);
        execSync(`git fetch origin ${GITHUB_BASE_REF}`, { stdio: 'inherit' });
        const fullDiff = execSync(`git diff origin/${GITHUB_BASE_REF}...HEAD`, { encoding: 'utf-8' }).toString();
        const changedFiles = execSync(`git diff --name-only origin/${GITHUB_BASE_REF}...HEAD`, { encoding: 'utf-8' }).split('\n').filter(Boolean);
        if (!fullDiff.trim()) {
            console.log("No changes detected. Skipping AI review.");
            process.exit(0);
        }
        console.log("Changed files:", changedFiles);
        return { diff: fullDiff, changedFiles };
    } catch (e) {
        console.error("Failed to get git diff:", e.message);
        process.exit(1);
    }
}

/**
 * Generates a Markdown summary of the entire code review.
 * @param {string[]} overallSummaries An array of summary strings from the AI.
 * @param {Set<string|object>} allHighlights A set of all highlight items.
 * @param {object[]} filteredIssues An array of issue objects relevant to the PR.
 * @returns {string} The formatted Markdown summary.
 */
function generateReviewSummary(overallSummaries, allHighlights, filteredIssues) {
    // FIX: Process highlights to handle both strings and objects.
    const highlightItems = [...allHighlights].map(p => {
        if (typeof p === 'string') {
            return `- ${p}`; // It's already a string, just use it.
        }
        if (typeof p === 'object' && p !== null) {
            // If it's an object, try to format it from its properties.
            if (p.category && p.description) {
                return `- ${p.category}: ${p.description}`;
            }
            // As a fallback, convert the object to a JSON string.
            return `- ${JSON.stringify(p)}`;
        }
        return `- ${p}`; // Default for any other type.
    }).join('\n');

    let summary = `### AI Code Review Summary\n\n**📝 Overall Impression:**\n${overallSummaries.join("\n\n")}\n\n**✅ Highlights:**\n${highlightItems || 'No significant improvements noted.'}`;
    
    if (filteredIssues.length) {
        summary += `\n\n<details>\n<summary>⚠️ **Detected Issues (${filteredIssues.length})** — Click to expand</summary><br>\n`;
        for (const issue of filteredIssues) {
            let emoji = '🔵'; // Info
            if (issue.severity === 'CRITICAL') emoji = '🔴';
            else if (issue.severity === 'MAJOR') emoji = '🟠';
            else if (issue.severity === 'MINOR') emoji = '🟡';
            summary += `\n- <details>\n  <summary><strong>${emoji} ${issue.title}</strong> <em>(${issue.severity})</em></summary>\n\n  **📁 File:** \`${issue.file}\` \n  **🔢 Line:** ${issue.line || 'N/A'}\n\n  **📝 Description:** \n  ${issue.description}\n\n  **💡 Suggestion:** \n  ${issue.suggestion}\n  </details>`;
        }
        summary += `\n</details>`;
    }
    return summary;
}

/**
 * Posts the main review summary comment to the GitHub pull request.
 * @param {object} octokit An authenticated Octokit instance.
 * @param {string} owner The repository owner.
 * @param {string} repo The repository name.
 * @param {number} prNumber The pull request number.
 * @param {string} commitId The SHA of the head commit.
 * @param {string} summary The Markdown summary to post.
 * @returns {Promise<void>}
 */
async function postReviewSummary(octokit, owner, repo, prNumber, commitId, summary) {
    try {
        await octokit.rest.pulls.createReview({ owner, repo, pull_number: prNumber, commit_id: commitId, event: 'COMMENT', body: summary });
        console.log('Successfully posted overall review summary.');
    } catch (error) {
        console.error('Failed to post overall review summary:', error.message);
    }
}

/**
 * Posts individual review comments for each detected issue on the relevant lines of the PR.
 * @param {object} octokit An authenticated Octokit instance.
 * @param {string} owner The repository owner.
 * @param {string} repo The repository name.
 * @param {number} prNumber The pull request number.
 * @param {string} commitId The SHA of the head commit.
 * @param {object[]} issues An array of issue objects to comment on.
 * @param {string} fullDiff The entire git diff string for snippet matching.
 * @returns {Promise<void>}
 */
async function postIssueComments(octokit, owner, repo, prNumber, commitId, issues, fullDiff) {
    for (const issue of issues) {
        let commentLine;
        // Construct the base body first
        let body = `**AI Suggestion: ${issue.title}** (${issue.severity})\n\n${issue.description}\n\n**Suggestion:**\n${issue.suggestion}\n\n${issue.proposed_code_snippet ? `\`\`\`suggestion\n${issue.proposed_code_snippet}\n\`\`\`` : ''}`;

        if (issue.chunkType === 'function') {
            commentLine = issue.functionStartLine;
            console.log(`Pinning comment for "${issue.title}" to function start line ${commentLine} in ${issue.file}`);
        } else {
            const snippetLocation = matchSnippetFromDiff(fullDiff, issue.file, issue.code_snippet);
            
            // --- MODIFICATION START ---
            if (snippetLocation) {
                // If we found a match, use its start line
                commentLine = snippetLocation.start;
            } else {
                // If no match, fallback to a file-level comment on line 1
                console.warn(`Could not find exact diff location for "${issue.title}" in ${issue.file}. Posting as a file-level comment.`);
                commentLine = 1;
                // Prepend a note to the body explaining the situation
                body = `**⚠️ AI Suggestion (could not pinpoint exact line): ${issue.title}** (${issue.severity})\n\n> This comment is placed at the top of the file because the exact location of the code snippet could not be found in the diff.\n\n---\n\n` + body;
            }
            // --- MODIFICATION END ---
        }

        if (!commentLine) continue;

        try {
            await octokit.rest.pulls.createReviewComment({ owner, repo, pull_number: prNumber, commit_id: commitId, path: issue.file, line: commentLine, side: 'RIGHT', body });
            console.log(`Posted inline comment for: "${issue.title}" in ${issue.file}:${commentLine}`);
        } catch (commentError) {
            console.error(`Failed to post inline comment for "${issue.title}":`, commentError.message);
        }
    }
}


// --- Main Review Logic ---

/**
 * The main orchestrator function for the entire code review process.
 * @returns {Promise<void>}
 */
async function reviewCode() {
    const { diff: fullDiff, changedFiles } = getGitDiff();
    const fileChunks = splitDiffByFileChunks(fullDiff);

    const allIssues = [], allHighlights = new Set(), overallSummaries = [];
    const baseDiffPromptTokens = estimateTokens(buildDiffReviewPrompt(""));
    const baseFunctionPromptTokens = estimateTokens(buildFunctionReviewPrompt(""));

    for (const file of fileChunks) {
        const { filePath, diff: fileDiffText, parsedFile } = file;
        console.log(`\n---\n📄 Reviewing file: ${filePath}`);
        const diffTokens = estimateTokens(fileDiffText);
        let chunksToProcess = [];
        let promptTokensForChunking = baseDiffPromptTokens;

        if (promptTokensForChunking + diffTokens > TOKEN_LIMIT) {
            console.log(`   - ❗ File diff is large (${diffTokens} tokens), attempting to split by function (Level 2)...`);
            promptTokensForChunking = baseFunctionPromptTokens;
            chunksToProcess = chunkByFunction(filePath, parsedFile, promptTokensForChunking, TOKEN_LIMIT);
            if (chunksToProcess && chunksToProcess.length > 0) {
                console.log(`   - ✅ Successfully split into ${chunksToProcess.length} function-based chunks.`);
            } else {
                console.log(`   - ⚠️ Could not split by function. Falling back to line-based chunking (Level 3)...`);
                promptTokensForChunking = baseDiffPromptTokens;
                chunksToProcess = splitLargeFileChunks(parsedFile, promptTokensForChunking, TOKEN_LIMIT);
                console.log(`   - ✅ Split into ${chunksToProcess.length} token-aware diff chunks.`);
            }
        } else {
            console.log(`   - ✅ Reviewing entire file diff (${diffTokens} tokens) as a single chunk (Level 1).`);
            chunksToProcess = [{ type: 'diff', chunkText: fileDiffText, filePath }];
        }

        for (const [index, chunk] of chunksToProcess.entries()) {
            if (chunksToProcess.length > 1) console.log(`     - Processing chunk ${index + 1} of ${chunksToProcess.length} (Type: ${chunk.type})...`);
            const prompt = chunk.type === 'function' ? buildFunctionReviewPrompt(chunk.chunkText) : buildDiffReviewPrompt(chunk.chunkText);
            const promptTokens = chunk.type === 'function' ? baseFunctionPromptTokens : baseDiffPromptTokens;
            
            let reviewRaw;
            try {
                reviewRaw = await callAIModel(AI_MODEL, prompt, promptTokens);
            } catch (error) { continue; }
            if (!reviewRaw) { console.error(`Received empty response from AI for ${chunk.filePath}.`); continue; }

            try {
                const parsedReview = JSON.parse(reviewRaw.replace(/```json|```/g, "").trim());
                if (parsedReview.overall_summary && index === 0) overallSummaries.push(parsedReview.overall_summary);
                if (parsedReview.highlights) parsedReview.highlights.forEach(h => allHighlights.add(h));
                if (parsedReview.issues?.length) {
                    const issuesWithMetadata = parsedReview.issues.map(issue => ({ ...issue, file: chunk.filePath, chunkType: chunk.type, functionStartLine: chunk.startLine || null }));
                    allIssues.push(...issuesWithMetadata);
                }
            } catch (e) {
                console.error(`Failed to parse AI JSON response for ${chunk.filePath}:`, e.message);
                console.log("\n--- START: RAW AI Response that failed to parse ---\n");
                console.log(reviewRaw);
                console.log("\n--- END: RAW AI Response ---\n");
        // ------------------------------------------
            }
        }
        console.log(`--- Finished reviewing file: ${filePath}`);
    }

    const octokit = github.getOctokit(GITHUB_TOKEN);
    const [owner, repo] = GITHUB_REPOSITORY.split('/');
    const prNumber = github.context.payload.pull_request?.number;
    if (!prNumber) { console.error("Could not determine PR number."); process.exit(1); }
    const commitId = github.context.payload.pull_request?.head?.sha;
    if (!commitId) { console.error("Could not determine commit ID."); process.exit(1); }

    const filteredIssues = allIssues.filter(issue => changedFiles.includes(issue.file));
    const summaryMarkdown = generateReviewSummary(overallSummaries, allHighlights, filteredIssues);
    await postReviewSummary(octokit, owner, repo, prNumber, commitId, summaryMarkdown);
    await postIssueComments(octokit, owner, repo, prNumber, commitId, filteredIssues, fullDiff);

    console.log('\nAI Code Review complete.');
}

// --- Execute Script ---
reviewCode().catch(error => {
    console.error("An unhandled error occurred during the AI code review:", error);
    process.exit(1);
});