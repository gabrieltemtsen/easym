import {
  Action,
  elizaLogger,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  generateText,
  ModelClass,
  UUID,
  Provider,
  Plugin
} from "@elizaos/core";
import { v4 as uuidv4 } from 'uuid';

// ============================================================
// CONSTANTS & CONFIGURATION
// ============================================================

const COOPERATIVE_MAP: Record<string, string> = {
  "TESTING": "testing",
  "NSCDCKWACOOP": "nscdckwacoop",
  "NSCDCJOS": "nscdcjos",
  "CTLS": "ctls",
  "FUSION": "fusion",
  "LIFELINEMCS": "lifelinemcs",
  "TFC": "tfc",
  "IMMIGRATION": "immigrationmcs",
  "IMMIGRATIONMCS": "immigrationmcs",
  "OCTICS": "octics",
  "MILLY": "milly",
  "AVIATIONABJ": "aviationabj",
  "FCDAMCS": "fcdamcs",
  "INECBAUCHI": "inecbauchi",
  "INECKWARA": "ineckwara",
  "GPMS": "gpms",
  "INECHQMCS": "inechqmcs",
  "NNMCSL": "nnmcsl",
  "INECSMCS": "inecsmcs",
  "MODACS": "modacs",
  "NCCMCS": "nccmcs",
  "NICNMCS": "nicnmcs",
  "OAGF": "oagf",
  "SAMCOS": "samcos",
  "VALGEECS": "valgeecs"
};

const FSN_HASH = process.env.FSN_HASH as string;
const AUTH_STATE_TABLE = "auth_state";

// Authentication state types
enum AuthState {
  NEED_COOPERATIVE = 'NEED_COOPERATIVE',
  NEED_CREDENTIALS = 'NEED_CREDENTIALS',
  NEED_OTP = 'NEED_OTP',
  AUTHENTICATED = 'AUTHENTICATED',
  FAILED = 'FAILED'
}

// ============================================================
// UTILITY & HELPER FUNCTIONS
// ============================================================

/**
 * Mask an email address for privacy.
 */
function maskEmail(email: string): string {
  if (!email) return "";
  if (!email.includes('@') || email.split('@').length !== 2) {
    return email.length > 4 ? `${email.substring(0, 2)}${'*'.repeat(email.length - 2)}` : email;
  }
  const [name, domain] = email.split('@');
  if (name.length <= 2) return email;
  const maskedName = `${name.substring(0, 2)}${'*'.repeat(Math.min(name.length - 2, 6))}`;
  return `${maskedName}@${domain}`;
}

/**
 * Validate a cooperative name input.
 * Uses normalization, partial match, then fuzzy matching.
 */
function validateCooperative(input: string): string | null {
  if (!input) return null;
  const normalizedInput = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  elizaLogger.debug(`Validating cooperative input: ${input} -> normalized: ${normalizedInput}`);

  // Exact match
  if (COOPERATIVE_MAP[normalizedInput]) {
    elizaLogger.info(`Exact match found for ${normalizedInput}`);
    return COOPERATIVE_MAP[normalizedInput];
  }
  // Partial match
  for (const [key, value] of Object.entries(COOPERATIVE_MAP)) {
    if (normalizedInput.includes(key) || key.includes(normalizedInput)) {
      elizaLogger.info(`Partial match found: ${normalizedInput} ~ ${key}`);
      return value;
    }
  }
  // Fuzzy matching based on string similarity
  let bestMatch: { key: string; value: string; score: number } | null = null;
  for (const [key, value] of Object.entries(COOPERATIVE_MAP)) {
    const score = stringSimilarity(normalizedInput, key);
    if (score > 0.6 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { key, value, score };
    }
  }
  if (bestMatch) {
    elizaLogger.info(`Fuzzy match found: ${normalizedInput} ~ ${bestMatch.key} (score: ${bestMatch.score.toFixed(2)})`);
    return bestMatch.value;
  }
  elizaLogger.warn(`No match found for cooperative: ${input}`);
  return null;
}

/**
 * Compute similarity score between two strings using Levenshtein distance.
 */
function stringSimilarity(a: string, b: string): number {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length <= b.length ? a : b;
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;
  return (longerLength - editDistance(longer, shorter)) / longerLength;
}

/**
 * Calculate Levenshtein distance between two strings.
 */
function editDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) {
    matrix[0][i] = i;
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[j][0] = j;
  }
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Check if an email is in a valid format.
 */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ============================================================
// AUTHENTICATION STATE MANAGEMENT
// ============================================================

/**
 * Get the authentication state for a room.
 */
async function getAuthState(runtime: IAgentRuntime, roomId: UUID): Promise<any> {
  elizaLogger.debug(`Getting auth state for room: ${roomId}`);
  try {
    const memories = await runtime.databaseAdapter.getMemories({
      roomId,
      tableName: AUTH_STATE_TABLE,
      agentId: runtime.agentId,
      count: 1,
      unique: true
    });
    if (memories.length > 0) {
      elizaLogger.debug(`Found auth state for room ${roomId}`, memories[0].content);
      return memories[0].content;
    } else {
      const defaultState = { status: AuthState.NEED_COOPERATIVE, roomId };
      elizaLogger.debug(`No auth state found for room ${roomId}, returning default state`);
      return defaultState;
    }
  } catch (error: any) {
    elizaLogger.error(`Error getting auth state for room ${roomId}:`, error);
    return { status: AuthState.NEED_COOPERATIVE, roomId, error: error.message };
  }
}

/**
 * Set or update the authentication state for a room.
 */
async function setAuthState(runtime: IAgentRuntime, roomId: UUID, stateData: any): Promise<void> {
  elizaLogger.debug(`Setting auth state for room ${roomId}:`, {
    ...stateData,
    token: stateData.token ? '[REDACTED]' : undefined,
    otp: stateData.otp ? '[REDACTED]' : undefined,
    credentials: stateData.credentials
      ? { email: stateData.credentials.email ? maskEmail(stateData.credentials.email) : undefined, employee_number: stateData.credentials.employee_number }
      : undefined
  });
  try {
    const updatedStateData = {
      ...stateData,
      roomId,
      updatedAt: new Date().toISOString()
    };
    const memory = {
      id: uuidv4() as UUID,
      roomId,
      userId: runtime.agentId,
      agentId: runtime.agentId,
      createdAt: Date.now(),
      content: updatedStateData,
    } as Memory;
    await runtime.databaseAdapter.createMemory(memory, AUTH_STATE_TABLE, true);
    elizaLogger.debug(`Successfully set auth state for room ${roomId}`);
  } catch (error: any) {
    elizaLogger.error(`Error setting auth state for room ${roomId}:`, error);
    throw error;
  }
}

/**
 * Reset the authentication state for a room.
 */
async function resetAuthState(runtime: IAgentRuntime, roomId: UUID): Promise<void> {
  elizaLogger.info(`Resetting auth state for room ${roomId}`);
  try {
    await setAuthState(runtime, roomId, {
      status: AuthState.NEED_COOPERATIVE,
      resetAt: new Date().toISOString()
    });
    elizaLogger.info(`Successfully reset auth state for room ${roomId}`);
  } catch (error: any) {
    elizaLogger.error(`Error resetting auth state for room ${roomId}:`, error);
    throw error;
  }
}

/**
 * Check if a user is in an active authentication flow.
 */
async function isUserInAuthFlow(runtime: IAgentRuntime, roomId: UUID): Promise<boolean> {
  const state = await getAuthState(runtime, roomId);
  const isInFlow = state.status !== AuthState.AUTHENTICATED && state.status !== undefined;
  elizaLogger.debug(`User in room ${roomId} is in auth flow: ${isInFlow}, auth state: ${state.status}`);
  return isInFlow;
}

/**
 * Periodically check and reset expired auth states.
 */
async function checkAndResetExpiredAuthState(runtime: IAgentRuntime, roomId: UUID): Promise<boolean> {
  try {
    const authState = await getAuthState(runtime, roomId);
    if (authState.status === AuthState.AUTHENTICATED || authState.status === undefined) {
      return false;
    }
    const now = Date.now();
    const updatedAt = new Date(authState.updatedAt || 0).getTime();
    let timeoutThreshold = 30 * 60 * 1000; // default 30 minutes
    if (authState.status === AuthState.NEED_OTP) timeoutThreshold = 15 * 60 * 1000;
    else if (authState.status === AuthState.NEED_CREDENTIALS) timeoutThreshold = 20 * 60 * 1000;
    if (now - updatedAt > timeoutThreshold) {
      elizaLogger.info(`Auth flow timed out for room ${roomId}, last updated ${(now - updatedAt) / 60000} minutes ago`);
      await setAuthState(runtime, roomId, {
        status: AuthState.NEED_COOPERATIVE,
        userId: authState.userId,
        previousState: authState.status,
        timedOut: true
      });
      return true;
    }
    return false;
  } catch (error: any) {
    elizaLogger.error(`Error checking expired auth state for room ${roomId}:`, error);
    return false;
  }
}

/**
 * Cleanup expired auth states (placeholder for DB-specific logic).
 */
async function cleanupExpiredAuthStates(runtime: IAgentRuntime) {
  try {
    elizaLogger.info('Running auth state cleanup');
    const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
    elizaLogger.info(`Would clean up auth states older than ${new Date(cutoffTime).toISOString()}`);
    // Example: Implement cleanup if your DB adapter supports it.
  } catch (error: any) {
    elizaLogger.error('Error during auth state cleanup', error);
  }
}
// Run cleanup every hour
setInterval(() => {
  if (typeof globalThis.runtime !== 'undefined') {
    cleanupExpiredAuthStates(globalThis.runtime);
  }
}, 60 * 60 * 1000);

// ============================================================
// AUTHENTICATION HANDLERS
// ============================================================

/**
 * Handle cooperative selection.
 */
async function handleCooperativeSelection(
  runtime: IAgentRuntime,
  message: Memory,
  authState: any,
  callback: HandlerCallback
): Promise<boolean> {
  const text = message.content.text.toLowerCase();
  elizaLogger.info(`Handling cooperative selection for message: "${text}"`);

  // Check for direct matches first.
  for (const [key, value] of Object.entries(COOPERATIVE_MAP)) {
    if (text.includes(key.toLowerCase())) {
      elizaLogger.info(`Found cooperative directly in message: ${key}`);
      await setAuthState(runtime, message.roomId, {
        ...authState,
        status: AuthState.NEED_CREDENTIALS,
        cooperative: value,
        originalCoopName: key
      });
      await callback({
        text: `Thank you! I've identified you as a member of ${key}. Please provide your email address and employee number for verification.`
      });
      return true;
    }
  }

  // Use LLM extraction if direct match failed.
  const context = `
Extract the cooperative name from the following user message. Only respond with the exact cooperative name.
If no cooperative name is mentioned, respond with "UNKNOWN".

Available cooperatives: ${Object.keys(COOPERATIVE_MAP).join(', ')}

User message: "${text}"
  `;
  elizaLogger.debug(`Generating text for cooperative extraction with context: ${context}`);
  const cooperativeName = (await generateText({
    runtime,
    context,
    modelClass: ModelClass.SMALL,
    stop: ["\n"],
  })).trim();

  elizaLogger.info(`Extracted cooperative name: "${cooperativeName}"`);
  const normalizedCoop = cooperativeName.toUpperCase();
  const tenantId = COOPERATIVE_MAP[normalizedCoop];
  if (tenantId) {
    elizaLogger.info(`Successfully identified cooperative: "${normalizedCoop}" -> ${tenantId}`);
    await setAuthState(runtime, message.roomId, {
      ...authState,
      status: AuthState.NEED_CREDENTIALS,
      cooperative: tenantId,
      originalCoopName: normalizedCoop
    });
    await callback({
      text: `Thank you! I've identified you as a member of ${normalizedCoop}. Please provide your email and employee number for verification.`
    });
    return true;
  }
  elizaLogger.warn(`Failed to identify cooperative: "${cooperativeName}"`);
  const exampleCoops = Object.keys(COOPERATIVE_MAP).slice(0, 5).join(', ');
  await callback({
    text: `I couldn't identify which cooperative you're referring to. Please specify one, for example: ${exampleCoops}, etc.`
  });
  return true;
}

/**
 * Handle credentials collection (email and employee number).
 */
async function handleCredentialsCollection(
  runtime: IAgentRuntime,
  message: Memory,
  authState: any,
  callback: HandlerCallback
): Promise<boolean> {
  const text = message.content.text;
  elizaLogger.info(`Handling credentials collection for room ${message.roomId}`);
  elizaLogger.debug(`Message text: "${text}"`);

  // Use LLM extraction for email and employee number.
  const context = `
Extract the email and employee number from the following user message.
The email should be in a valid format (user@domain.com).
The employee number follows formats like FUS00005, NSCDC123, etc.
Respond in strict JSON format ONLY: {"email": string, "employee_number": string}
If a field is missing or invalid, set it to null.

Examples:
- "my email is test@example.com and ID is FUS123" => {"email": "test@example.com", "employee_number": "FUS123"}
- "here's my info: FUS00005 test@coop.com" => {"email": "test@coop.com", "employee_number": "FUS00005"}
- "email: user@test.com" => {"email": "user@test.com", "employee_number": null}

User message: "${text}"
`;
  elizaLogger.debug(`Generating text for credentials extraction`);
  let extractionResult = await generateText({
    runtime,
    context,
    modelClass: ModelClass.SMALL,
  });
  const cleanedResult = extractionResult.replace(/```json|```/g, '').trim();
  elizaLogger.debug(`Cleaned extraction result: ${cleanedResult}`);
  extractionResult = cleanedResult;

  let credentials;
  try {
    credentials = JSON.parse(extractionResult);
    elizaLogger.info(`Parsed credentials - Email: ${maskEmail(credentials.email)}, Employee #: ${credentials.employee_number}`);
  } catch (error: any) {
    elizaLogger.error('Error parsing credentials JSON', { error: error.message, extractionResult });
    await callback({
      text: "I couldn't extract your information properly. Please provide your email and employee number clearly, e.g.,\n\nEmail: your@email.com\nEmployee #: ABC12345"
    });
    return true;
  }

  if (!credentials.email || !isValidEmail(credentials.email)) {
    elizaLogger.warn(`Invalid or missing email: ${credentials.email}`);
    await callback({
      text: "I need a valid email address. Please provide your email address."
    });
    return true;
  }
  if (!credentials.employee_number) {
    elizaLogger.warn(`Missing employee number`);
    await callback({
      text: "I also need your employee number. Please provide it."
    });
    return true;
  }

  // Proceed with API authentication.
  try {
    const apiUrl = `https://api.techfsn.com/api/bot/authenticate-client`;
    const requestBody = {
      email: credentials.email,
      employee_number: credentials.employee_number,
      tenant: authState.cooperative
    };
    elizaLogger.info(`Authenticating user with API`, {
      url: apiUrl,
      tenant: authState.cooperative,
      employee_number: credentials.employee_number,
      email: maskEmail(credentials.email)
    });
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'fsn-hash': FSN_HASH
      },
      body: JSON.stringify(requestBody),
    });
    elizaLogger.info(`Auth API response status: ${response.status}`);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: "Authentication failed" }));
      elizaLogger.error(`Auth API error: ${response.status} - ${errorData.message || 'Unknown error'}`);
      let errorMessage = "I couldn't authenticate you with the provided details. ";
      if (response.status === 404) {
        errorMessage += "The details you provided weren't found. Please check and try again.";
      } else if (response.status === 401) {
        errorMessage += "Your credentials seem invalid. Please verify your email and employee number.";
      } else {
        errorMessage += "Please verify your details and try again.";
      }
      await callback({ text: errorMessage });
      return true;
    }
    const data = await response.json();
    elizaLogger.debug(`Auth API parsed response:`, data);
    if (!data.data.otp || !data.data.token) {
      elizaLogger.error('API response missing required fields', data);
      throw new Error('Invalid API response - missing OTP or token');
    }
    elizaLogger.info(`Authentication successful, OTP generated`);
    await setAuthState(runtime, message.roomId, {
      ...authState,
      status: AuthState.NEED_OTP,
      credentials,
      otp: data.data.otp,
      token: data.data.token,
      responseData: data,
      postAuthAction: "AUTHENTICATE_USER",
      otpGeneratedAt: new Date().toISOString()
    });
    const maskedEmail = maskEmail(credentials.email);
    await callback({
      text: `An OTP code has been sent to ${maskedEmail}. Please check your inbox and provide the 6-digit code.`
    });
    return true;
  } catch (error: any) {
    elizaLogger.error('Error during authentication', error);
    await callback({
      text: "I encountered an error during authentication. Please try providing your email and employee number again."
    });
    return true;
  }
}

/**
 * Main authentication handler.
 */
async function handleAuthentication(
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  callback: HandlerCallback
): Promise<boolean> {
  const roomId = message.roomId;
  const userId = message.userId;
  elizaLogger.info(`Handling authentication for room ${roomId}, user ${userId}`);
  const authState = await getAuthState(runtime, roomId);
  elizaLogger.info(`Current auth state: ${authState.status}`);

  // If a pure numeric message is received in NEED_OTP state, defer to OTP handler.
  if (authState.status === AuthState.NEED_OTP && /^\d+$/.test(message.content.text.trim())) {
    elizaLogger.info(`Skipping OTP handling in authenticateAction - deferring to VERIFY_OTP action`);
    return false;
  }

  switch (authState.status) {
    case AuthState.NEED_COOPERATIVE:
      elizaLogger.info(`Starting cooperative selection flow`);
      return await handleCooperativeSelection(runtime, message, authState, callback);
    case AuthState.NEED_CREDENTIALS:
      elizaLogger.info(`Starting credentials collection flow`);
      return await handleCredentialsCollection(runtime, message, authState, callback);
    case AuthState.NEED_OTP:
      elizaLogger.info(`Deferring OTP handling to VERIFY_OTP action`);
      await callback({ text: "Please enter the 6-digit verification code sent to your email." });
      return true;
    case AuthState.AUTHENTICATED:
      elizaLogger.info(`User is already authenticated`);
      if (authState.postAuthAction) {
        elizaLogger.info(`Executing pending post-auth action: ${authState.postAuthAction}`);
        return await handlePostAuthAction(runtime, authState, callback);
      }
      await callback({ text: "You're already authenticated! How can I help you today?" });
      return true;
    case AuthState.FAILED:
      elizaLogger.info(`Resetting failed auth state`);
      await setAuthState(runtime, roomId, { 
        status: AuthState.NEED_COOPERATIVE,
        userId,
        postAuthAction: authState.postAuthAction
      });
      await callback({ text: "Let's try authenticating again. Which cooperative do you belong to?" });
      return true;
    default:
      elizaLogger.info(`Starting new auth flow`);
      await setAuthState(runtime, roomId, { status: AuthState.NEED_COOPERATIVE, userId });
      await callback({ text: "To help you, I'll need to authenticate you first. Which cooperative do you belong to? (e.g., Fusion, CTLS, Octics)" });
      return true;
  }
}

/**
 * Handle any pending post-authentication actions.
 */
async function handlePostAuthAction(runtime: IAgentRuntime, authState: any, callback: HandlerCallback): Promise<boolean> {
  if (!authState.postAuthAction) return false;
  elizaLogger.info(`Handling post-auth action: ${authState.postAuthAction}`);
  switch (authState.postAuthAction) {
    case "CHECK_LOAN":
      try {
        const loanInfoType = "DETAILS";
        const apiUrl = `https://api.techfsn.com/api/bot/client-loan-info?tenant=${authState.cooperative}&employee_number=${authState.credentials.employee_number}`;
        elizaLogger.info(`Executing post-auth loan check: ${apiUrl}`);
        const response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${authState.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'fsn-hash': FSN_HASH
          }
        });
        if (!response.ok) throw new Error(`API error: ${response.status}`);
        const loanData = await response.json();
        const formattedResponse = await formatLoanResponse(runtime, loanData, loanInfoType);
        await callback({ text: formattedResponse });
        await setAuthState(runtime, authState.roomId, { ...authState, postAuthAction: null });
        return true;
      } catch (error: any) {
        elizaLogger.error('Error executing post-auth loan check', error);
        await callback({
          text: "I authenticated you successfully, but encountered an issue retrieving your loan information. Please ask about your loan again."
        });
        return true;
      }
    default:
      return false;
  }
}

// ============================================================
// LOAN INFORMATION HANDLERS
// ============================================================

/**
 * Determine the specific type of loan information requested.
 */
async function determineLoanInfoType(runtime: IAgentRuntime, message: string): Promise<string> {
  elizaLogger.debug(`Determining loan info type for message: "${message}"`);
  const context = `
Determine what specific loan information the user is asking about from their message.
Respond with one of the following categories ONLY (no explanation):
- STATUS (if asking about approval status, pending, etc.)
- AMOUNT (if asking about loan amount, balance, etc.)
- PAYMENT (if asking about payments, due dates, etc.)
- ELIGIBILITY (if asking about qualification, can they get a loan, etc.)
- HISTORY (if asking about past loans, loan history, etc.)
- DETAILS (for any general loan information)

User message: "${message}"
  `;
  const loanInfoType = (await generateText({
    runtime,
    context,
    modelClass: ModelClass.SMALL,
    stop: ["\n"],
  })).trim();
  const validTypes = ["STATUS", "AMOUNT", "PAYMENT", "ELIGIBILITY", "HISTORY", "DETAILS"];
  const normalizedType = loanInfoType.toUpperCase();
  if (!validTypes.includes(normalizedType)) {
    elizaLogger.warn(`Invalid loan info type returned: "${loanInfoType}", defaulting to DETAILS`);
    return "DETAILS";
  }
  elizaLogger.debug(`Determined loan info type: ${normalizedType}`);
  return normalizedType;
}

/**
 * Format the loan response using an LLM for a friendly UX.
 */
async function formatLoanResponse(runtime: IAgentRuntime, loanData: any, infoType: string): Promise<string> {
  elizaLogger.debug(`Formatting loan response for type: ${infoType}`);
  if (!loanData || (typeof loanData === 'object' && Object.keys(loanData).length === 0) || (Array.isArray(loanData) && loanData.length === 0)) {
    elizaLogger.info('No loan data available for user');
    return "I checked your account, but there are no active loans. If you believe this is incorrect, please contact your cooperative's support.";
  }
  try {
    const sanitizedData = sanitizeLoanData(loanData);
    elizaLogger.debug(`Sanitized loan data for formatting`, sanitizedData);
    const context = `
You are a financial assistant helping a cooperative member understand their loan information.
Below is their sanitized loan data:

${JSON.stringify(sanitizedData, null, 2)}

The member is asking about: ${infoType}

Write a helpful, clear response addressing their specific question.
Follow these guidelines:
1. Be specific with numbers, dates, and statuses.
2. Format currency values with the ₦ symbol.
3. Use a warm, supportive tone.
4. Present dates in a friendly format.
5. If information is missing, explain politely.

Keep your response under 150 words.
    `;
    elizaLogger.debug('Generating formatted loan response text');
    const formattedResponse = await generateText({
      runtime,
      context,
      modelClass: ModelClass.LARGE,
    });
    elizaLogger.debug(`Generated loan response (${formattedResponse.length} chars)`);
    return formattedResponse;
  } catch (error: any) {
    elizaLogger.error('Error formatting loan response:', error);
    return createFallbackLoanResponse(loanData, infoType);
  }
}

/**
 * Sanitize loan data to avoid formatting errors.
 */
function sanitizeLoanData(loanData: any): any {
  if (Array.isArray(loanData)) {
    return loanData.map(loan => sanitizeLoanObject(loan));
  }
  return sanitizeLoanObject(loanData);
}

/**
 * Sanitize a single loan object.
 */
function sanitizeLoanObject(loan: any): any {
  if (!loan || typeof loan !== 'object') return { error: "Invalid loan data" };
  const sanitized: any = {};
  for (const [key, value] of Object.entries(loan)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && (key.toLowerCase().includes('date') || key.toLowerCase().includes('time'))) {
      try {
        const date = new Date(value);
        sanitized[key] = !isNaN(date.getTime()) ? date.toISOString() : value;
      } catch {
        sanitized[key] = value;
      }
      continue;
    }
    if (typeof value === 'number' && (key.toLowerCase().includes('amount') || key.toLowerCase().includes('payment') || key.toLowerCase().includes('balance'))) {
      sanitized[key] = value.toFixed(2);
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

/**
 * Provide context-specific instructions based on the info type.
 */
function getContextForInfoType(infoType: string): string {
  switch (infoType.toUpperCase()) {
    case 'STATUS':
      return "- Loan approval status, current stage, and pending actions";
    case 'AMOUNT':
      return "- Total approved amount, outstanding balance, and breakdown if available";
    case 'PAYMENT':
      return "- Next payment due date, amount, and history";
    case 'ELIGIBILITY':
      return "- Current eligibility status and suggestions for improvement";
    case 'HISTORY':
      return "- Summary of previous loans and payment history";
    default:
      return "- Overall loan details including key dates, balance, and terms";
  }
}

/**
 * Create a fallback loan response if formatting fails.
 */
function createFallbackLoanResponse(loanData: any, infoType: string): string {
  try {
    let loanAmount = "not specified";
    let loanStatus = "not specified";
    let nextPayment = "not specified";
    if (typeof loanData === 'object') {
      for (const key of Object.keys(loanData)) {
        if (key.toLowerCase().includes('amount') && loanData[key]) {
          const amount = parseFloat(loanData[key]);
          if (!isNaN(amount)) {
            loanAmount = `₦${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            break;
          }
        }
      }
      for (const key of Object.keys(loanData)) {
        if (key.toLowerCase().includes('status') && loanData[key]) {
          loanStatus = loanData[key].toString();
          break;
        }
      }
      for (const key of Object.keys(loanData)) {
        if ((key.toLowerCase().includes('next') && key.toLowerCase().includes('payment')) ||
            (key.toLowerCase().includes('due') && key.toLowerCase().includes('date'))) {
          if (loanData[key]) {
            try {
              const date = new Date(loanData[key]);
              nextPayment = !isNaN(date.getTime())
                ? date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
                : loanData[key].toString();
            } catch {
              nextPayment = loanData[key].toString();
            }
            break;
          }
        }
      }
    }
    const responses: Record<string, string> = {
      'STATUS': `Your current loan status is ${loanStatus}.`,
      'AMOUNT': `Your loan amount is ${loanAmount}.`,
      'PAYMENT': `Your next payment is due on ${nextPayment}.`,
      'ELIGIBILITY': `Please contact your cooperative for eligibility details.`,
      'HISTORY': `For detailed loan history, please contact your cooperative.`,
      'DETAILS': `Your loan amount is ${loanAmount}, status is ${loanStatus}, and next payment is due on ${nextPayment}.`
    };
    return responses[infoType.toUpperCase()] ||
      `I found your loan information but couldn't format it in detail. Please contact your cooperative's support for more details.`;
  } catch (error: any) {
    elizaLogger.error('Error creating fallback loan response:', error);
    return "I found your loan information, but I'm having trouble formatting the details. Please contact your cooperative's support.";
  }
}

// ============================================================
// ACTIONS & PROVIDERS
// ============================================================

// -------------------- AUTHENTICATE USER ACTION --------------------

const authenticateAction: Action = {
  name: "AUTHENTICATE_USER",
  description: "Handles user authentication for cooperative services",
  similes: [
    "LOGIN", "VERIFY_USER", "AUTH", "AUTHENTICATE", "SIGN IN",
    "VERIFY ME", "CHECK ACCOUNT", "ACCESS ACCOUNT", "VALIDATE USER",
    "CONFIRM IDENTITY", "AUTHENTICATION", "LOG ME IN", "VERIFY ACCOUNT"
  ],
  suppressInitialMessage: true,
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.trim();
    if (/^\d+$/.test(text)) {
      elizaLogger.info(`AUTHENTICATE_USER rejecting numeric input: "${text}"`);
      return false;
    }
    const authState = await getAuthState(runtime, message.roomId);
    if (authState.status !== AuthState.AUTHENTICATED && authState.status !== undefined) {
      if (authState.status === AuthState.NEED_OTP && /^\d+$/.test(text)) {
        elizaLogger.debug(`Message appears to be an OTP code, deferring to OTP action`);
        return false;
      }
      elizaLogger.debug(`User is in auth flow (${authState.status}), continuing authentication`);
      return true;
    }
    const authKeywords = ["login", "authenticate", "verify", "identity", "sign in", "credentials", "account access"];
    const containsAuthKeyword = authKeywords.some(keyword =>
      text.includes(keyword) || new RegExp(`\\b${keyword}\\b`).test(text)
    );
    const loanKeywords = ["loan", "borrow", "credit", "payment", "balance"];
    const containsLoanKeyword = loanKeywords.some(keyword =>
      text.includes(keyword) || new RegExp(`\\b${keyword}\\b`).test(text)
    );
    if (containsLoanKeyword && containsAuthKeyword) {
      elizaLogger.debug(`Message contains both loan and auth keywords, deferring to loan action`);
      return false;
    }
    elizaLogger.debug(`Message contains explicit auth keywords: ${containsAuthKeyword}`);
    return containsAuthKeyword;
  },
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options, callback: HandlerCallback) => {
    return await handleAuthentication(runtime, message, state, callback);
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "I need to login to my cooperative account" }
      },
      {
        user: "{{user2}}",
        content: { text: "I'll help you authenticate. Which cooperative do you belong to?", action: "AUTHENTICATE_USER" }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: { text: "How do I verify my identity?" }
      },
      {
        user: "{{user2}}",
        content: { text: "I can help you authenticate with your cooperative. Which cooperative do you belong to?", action: "AUTHENTICATE_USER" }
      }
    ]
  ],
};

// -------------------- RESET AUTH ACTION --------------------

const resetAction: Action = {
  name: "RESET_AUTH",
  description: "Reset authentication state and start fresh",
  similes: ["RESTART", "START_OVER", "RESET", "CLEAR", "REFRESH"],
  suppressInitialMessage: true,
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    const resetKeywords = ["reset", "restart", "start over", "clear", "begin again", "start fresh", "start new", "new session"];
    return resetKeywords.some(keyword => text.includes(keyword) || new RegExp(`\\b${keyword}\\b`).test(text));
  },
  handler: async (runtime: IAgentRuntime, message: Memory, _state: State, _options, callback: HandlerCallback) => {
    await resetAuthState(runtime, message.roomId);
    await callback({
      text: "I've reset our conversation. Let's start fresh! If you need help with your cooperative account, just let me know."
    });
    return true;
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "Reset our conversation" }
      },
      {
        user: "{{user2}}",
        content: { text: "I've reset our conversation. Let's start fresh!", action: "RESET_AUTH" }
      }
    ]
  ]
};

// -------------------- LOAN INFO ACTION --------------------

const loanInfoAction: Action = {
  name: "LOAN",
  description: "Check loan information for a user, initiating authentication if needed",
  similes: [
    "LOAN_INFO", "LOAN_STATUS", "CHECK_LOAN_INFO", "GET_LOAN_STATUS", "LOAN_BALANCE", "LOAN_DETAILS", "MY_LOAN", "VIEW_LOAN","CHECK_LOAN",
    "LOAN_QUERY", "LOAN_BALANCE", "LOAN_PAYMENT", "LOAN_HISTORY", "LOAN_ELIGIBILITY", "LOAN_AMOUNT", "LOAN_REPAYMENT"
  ],
  suppressInitialMessage: true,
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    elizaLogger.info(`Validating loan info action for message: "${message.content.text}"`);
    const text = message.content.text.toLowerCase();
    elizaLogger.debug(`Validating loan info action for message: "${text}"`);
    // IMMEDIATE REJECTION: If it's a numeric code, NEVER handle with loan action
    if (/^\d+$/.test(text)) {
      elizaLogger.info(`CHECK_LOAN rejecting numeric input: "${text}"`);
      return false;
    }
    // Removed extra OTP check and auth flow check so that the action triggers even when not authenticated.
    const loanKeywords = [
      "loan", "borrow", "credit", "debt", "owe", "payment", "balance", "due", "repayment", "interest", "principal",
      "check my", "view my", "show my", "get my", "tell me about my"
    ];
    const isLoanRelated = loanKeywords.some(keyword =>
      text.includes(keyword) || new RegExp(`\\b${keyword}\\b`).test(text)
    );
    elizaLogger.debug(`Message is loan related: ${isLoanRelated}`);
    return isLoanRelated;
  },
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: { [key: string]: unknown }, callback: HandlerCallback) => {
    elizaLogger.info(`Handling loan info action for room ${message.roomId}`);
    try {
      const authState = await getAuthState(runtime, message.roomId);
      // If not authenticated, start authentication flow
      if (authState.status !== AuthState.AUTHENTICATED) {
        elizaLogger.info(`User not authenticated, initiating auth flow for loan request`);
        await callback({
          text: "To check your loan information, I'll need to verify your identity first. Which cooperative do you belong to? (e.g., Fusion, CTLS, Octics)"
        });
        await setAuthState(runtime, message.roomId, {
          status: AuthState.NEED_COOPERATIVE,
          userId: message.userId,
          postAuthAction: "LOAN"
        });
        return true;
      }
      elizaLogger.info(`User is authenticated, fetching loan info`);
      const loanInfoType = await determineLoanInfoType(runtime, message.content.text);
      elizaLogger.info(`Determined loan info type: ${loanInfoType}`);
      const apiUrl = `https://api.techfsn.com/api/bot/client-loan-info?tenant=${authState.cooperative}&employee_number=${authState.credentials.employee_number}`;
      elizaLogger.info(`Fetching loan info from ${apiUrl}`);
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authState.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'fsn-hash': FSN_HASH,
          'token': authState.token
        }
      });
      elizaLogger.info(`Loan API response status: ${response.status}`);
      if (!response.ok) {
        if (response.status === 401) {
          elizaLogger.info('Token expired, restarting authentication flow');
          await callback({
            text: "Your session has expired. Let me re-authenticate you. Which cooperative do you belong to?"
          });
          await setAuthState(runtime, message.roomId, {
            status: AuthState.NEED_COOPERATIVE,
            userId: message.userId,
            postAuthAction: "LOAN"
          });
          return true;
        }
        const errorText = await response.text();
        elizaLogger.error(`Loan API error: ${response.status} - ${errorText}`);
        throw new Error(`Failed to fetch loan info: ${response.statusText}`);
      }
      const responseText = await response.text();
      let loanData;
      try {
        loanData = JSON.parse(responseText);
        elizaLogger.debug(`Loan API parsed response:`, loanData);
      } catch (e: any) {
        elizaLogger.error(`Failed to parse loan data JSON: ${e.message}`);
        throw new Error(`Invalid JSON response: ${responseText}`);
      }
      const formattedResponse = await formatLoanResponse(runtime, loanData, loanInfoType);
      elizaLogger.info('Loan info response:', formattedResponse);
      await callback({ text: formattedResponse });
      return true;
    } catch (error: any) {
      elizaLogger.error('Error fetching loan information', error);
      await callback({
        text: "I encountered an error while retrieving your loan information. Please try again by specifying your cooperative."
      });
      await setAuthState(runtime, message.roomId, {
        status: AuthState.NEED_COOPERATIVE,
        userId: message.userId,
        postAuthAction: "LOAN",
        lastError: error.message
      });
      return true;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "Can you tell me about my loan status?" }
      },
      {
        user: "{{user2}}",
        content: { text: "To check your loan information, I'll need to verify your identity first. Which cooperative do you belong to?", action: "CHECK_LOAN" }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: { text: "What's my current loan balance?" }
      },
      {
        user: "{{user2}}",
        content: { text: "To check your loan balance, I'll need to verify your identity first. Which cooperative do you belong to?", action: "CHECK_LOAN" }
      }
    ]
  ]
};

// -------------------- VERIFY OTP ACTION --------------------

const verifyOTPAction: Action = {
  name: "VERIFY_OTP",
  description: "Verifies the OTP code sent to the user's email during authentication",
  similes: ["CHECK_OTP", "ENTER_OTP", "VERIFY_CODE", "CONFIRM_OTP", "VALIDATE_OTP"],
  suppressInitialMessage: true,
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.trim();
    if (!/^\d+$/.test(text)) return false;
    elizaLogger.info(`Pure numeric input detected: "${text}"`);
    try {
      const authState = await getAuthState(runtime, message.roomId);
      elizaLogger.info(`Current auth state for numeric input: ${authState.status}`);
      if (authState.status !== AuthState.NEED_OTP) {
        elizaLogger.info(`Not in OTP verification state, skipping.`);
        return false;
      }
      elizaLogger.info(`✓ IN OTP VERIFICATION STATE - handling numeric input`);
      return true;
    } catch (error: any) {
      elizaLogger.error('Error in VERIFY_OTP validator:', error);
      return false;
    }
  },
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options, callback: HandlerCallback) => {
    elizaLogger.info(`VERIFY_OTP HANDLER EXECUTING for message: "${message.content.text}"`);
    try {
      const authState = await getAuthState(runtime, message.roomId);
      const enteredOTP = message.content.text.trim();
      elizaLogger.info(`Verifying OTP: entered=${enteredOTP}, expected=${authState.otp}`);
      if (authState.status !== AuthState.NEED_OTP) {
        elizaLogger.warn(`Not in OTP verification state. Current state: ${authState.status}`);
        return false;
      }
      if (enteredOTP === authState.otp) {
        elizaLogger.info(`★★★ OTP VERIFICATION SUCCESSFUL ★★★`);
        await setAuthState(runtime, message.roomId, {
          ...authState,
          status: AuthState.AUTHENTICATED,
          verifiedAt: new Date().toISOString()
        });
        elizaLogger.info(`Auth state updated to AUTHENTICATED`);
        if (authState.postAuthAction === "CHECK_LOAN") {
          elizaLogger.info(`Executing post-auth loan check`);
          await callback({ text: "You've been successfully authenticated! I'll now check your loan information." });
          const loanInfoType = await determineLoanInfoType(runtime, "loan information");
          const apiUrl = `https://api.techfsn.com/api/bot/client-loan-info?tenant=${authState.cooperative}&employee_number=${authState.credentials.employee_number}`;
          elizaLogger.info(`Fetching loan info from ${apiUrl}`);
          try {
            const response = await fetch(apiUrl, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${authState.token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'fsn-hash': FSN_HASH
              }
            });
            if (!response.ok) throw new Error(`API error: ${response.status}`);
            const loanData = await response.json();
            const formattedResponse = await formatLoanResponse(runtime, loanData, loanInfoType);
            await callback({ text: formattedResponse });
          } catch (error: any) {
            elizaLogger.error('Error fetching loan info after OTP verification', error);
            await callback({
              text: "I authenticated you successfully, but encountered an issue retrieving your loan information. Please ask about your loan again."
            });
          }
        } else {
          elizaLogger.info(`No post-auth action, sending success message`);
          await callback({
            text: "Authentication successful! You're now logged in. How can I help you today?"
          });
        }
        return true;
      } else {
        elizaLogger.warn(`OTP verification failed: entered "${enteredOTP}", expected "${authState.otp}"`);
        await callback({
          text: "The verification code you provided doesn't match. Please check your email and try again."
        });
        return true;
      }
    } catch (error: any) {
      elizaLogger.error('Error in VERIFY_OTP handler:', error);
      await callback({
        text: "I encountered an error verifying your code. Please try entering it again."
      });
      return true;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "123456" }
      },
      {
        user: "{{user2}}",
        content: { text: "Authentication successful! You're now logged in. How can I help you today?", action: "VERIFY_OTP" }
      }
    ]
  ]
};

// -------------------- PROVIDERS --------------------

const cooperativesProvider: Provider = {
  get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    const cooperativesList = Object.keys(COOPERATIVE_MAP).map(name => `- ${name}`).join('\n');
    return `
# Available Cooperatives
The following cooperatives are supported:
${cooperativesList}

You can validate cooperative names using the function validateCooperative(input).
If a user mentions a name like "Immigration", it will be normalized correctly.
    `;
  }
};

const authStatusProvider: Provider = {
  get: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    try {
      elizaLogger.debug(`Getting auth status for provider in room ${message.roomId}`);
      const memories = await runtime.databaseAdapter.getMemories({
        roomId: message.roomId,
        tableName: AUTH_STATE_TABLE,
        agentId: runtime.agentId,
        count: 1,
        unique: true
      });
      if (memories.length === 0) {
        return `User is not authenticated. No authentication state found.`;
      }
      const authState = memories[0].content as any;
      let statusMessage = `# Authentication Status\nCurrent status: ${authState.status}\n`;
      if (authState.cooperative) {
        statusMessage += `Cooperative: ${authState.originalCoopName} (${authState.cooperative})\n`;
      }
      if (authState.credentials) {
        statusMessage += `Email: ${maskEmail(authState.credentials.email)}\n`;
        statusMessage += `Employee #: ${authState.credentials.employee_number}\n`;
      }
      if (authState.verifiedAt) {
        statusMessage += `Verified at: ${authState.verifiedAt}\n`;
      }
      if (authState.lastError) {
        statusMessage += `Last error: ${authState.lastError}\n`;
      }
      return statusMessage;
    } catch (error: any) {
      elizaLogger.error('Error getting auth status for provider', error);
      return `Error retrieving authentication status: ${error.message}`;
    }
  }
};

// ============================================================
// PLUGIN DEFINITION
// ============================================================

const fusePlugin: Plugin = {
  name: "fuse-plugin",
  description: "Fuse Cooperative Management plugin for Eliza OS",
  providers: [cooperativesProvider, authStatusProvider],
  actions: [loanInfoAction, authenticateAction, verifyOTPAction,resetAction, ],
};

export default fusePlugin;
