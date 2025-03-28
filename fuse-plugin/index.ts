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
  
  // Cooperative Map
  const COOPERATIVE_MAP: Record<string, string> = {
    "TESTING": "testing",
    "NSCDCKWACOOP": "nscdckwacoop",
    "NSCDCJOS": "nscdcjos",
    "CTLS": "ctls",
    "FUSION": "fusion",
    "LIFELINEMCS": "lifelinemcs",
    "TFC": "tfc",
    "IMMIGRATION": "immigrationmcs", // Alias
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
  
// Enhanced AuthState enum with descriptions
enum AuthState {
    NEED_COOPERATIVE = 'NEED_COOPERATIVE', // Waiting for user to specify cooperative
    NEED_CREDENTIALS = 'NEED_CREDENTIALS', // Waiting for email/employee number
    NEED_OTP = 'NEED_OTP', // Waiting for OTP verification
    AUTHENTICATED = 'AUTHENTICATED', // Successfully authenticated
    FAILED = 'FAILED' // Authentication failed
  }
  
  // Define a specific table name for auth state
  const AUTH_STATE_TABLE = "auth_state";
  
 // Enhanced logging with colors and more context
function log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: any) {
    const timestamp = new Date().toISOString();
    const colors = {
      debug: '\x1b[36m', // Cyan
      info: '\x1b[32m', // Green
      warn: '\x1b[33m', // Yellow
      error: '\x1b[31m' // Red
    };
    const reset = '\x1b[0m';
    
    const formattedMessage = `${colors[level]}[FUSE-PLUGIN][${timestamp}][${level.toUpperCase()}] ${message}${reset}`;
    
    // Stringify data if it's an object
    const formattedData = data && typeof data === 'object' 
      ? JSON.stringify(data, null, 2) 
      : data;
  
    switch (level) {
      case 'debug':
        elizaLogger.debug(formattedMessage, formattedData);
        break;
      case 'info':
        elizaLogger.log(formattedMessage, formattedData);
        break;
      case 'warn':
        elizaLogger.warn(formattedMessage, formattedData);
        break;
      case 'error':
        elizaLogger.error(formattedMessage, formattedData);
        break;
    }
  }
  // Function to generate response when authentication fails with a 403 error
async function generateAuthErrorResponse(runtime: IAgentRuntime, errorStatus: number): Promise<string> {
  const context = `
Generate a helpful response for a user whose authentication has failed with a ${errorStatus} error.
The likely causes are:
${errorStatus === 401 ? "- Invalid credentials" : ""}
${errorStatus === 403 ? "- Session expired or access forbidden" : ""}
${errorStatus === 404 ? "- User account not found" : ""}

Inform them politely that you'll need to restart the authentication process.
Mention they can say "reset" or "start over" if they want to try again with different cooperative information.
Keep it conversational and helpful, under 100 words.
  `;
  
  try {
    const response = await generateText({
      runtime,
      context,
      modelClass: ModelClass.SMALL,
    });
    
    return response || "I'm having trouble accessing your account information. Let's try authenticating again. You can also say 'reset' or 'start over' if you'd like to begin fresh.";
  } catch (error) {
    elizaLogger.error('error', 'Error generating auth error response', error);
    return "I'm having trouble accessing your account information. Let's try authenticating again. You can also say 'reset' or 'start over' if you'd like to begin fresh.";
  }
}
  function maskEmail(email: string): string {
    // Return empty string for null/undefined inputs
    if (!email) return "";
    
    // Validate basic email format
    if (!email.includes('@') || email.split('@').length !== 2) {
      return email.length > 4 ? `${email.substring(0, 2)}${'*'.repeat(email.length - 2)}` : email;
    }
    
    const [name, domain] = email.split('@');
    
    // Handle short usernames
    if (name.length <= 2) {
      return email;
    }
    
    // Show first 2 characters, mask the rest
    const maskedName = `${name.substring(0, 2)}${'*'.repeat(Math.min(name.length - 2, 6))}`;
    
    return `${maskedName}@${domain}`;
  }
  
  
 // Enhanced cooperative validation with fuzzy matching
function validateCooperative(input: string): string | null {
    if (!input) return null;
    
    // Normalize input: uppercase and remove spaces/special chars
    const normalizedInput = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
    
    elizaLogger.debug('debug', `Validating cooperative input: ${input} -> normalized: ${normalizedInput}`);
    
    // 1. Exact match
    if (COOPERATIVE_MAP[normalizedInput]) {
      elizaLogger.info('info', `Exact match found for ${normalizedInput}`);
      return COOPERATIVE_MAP[normalizedInput];
    }
    
    // 2. Partial match (contains)
    for (const [key, value] of Object.entries(COOPERATIVE_MAP)) {
      if (normalizedInput.includes(key) || key.includes(normalizedInput)) {
        elizaLogger.info('info', `Partial match found: ${normalizedInput} ~ ${key}`);
        return value;
      }
    }
    
    // 3. Fuzzy match (similarity)
    let bestMatch: { key: string; value: string; score: number } | null = null;
    for (const [key, value] of Object.entries(COOPERATIVE_MAP)) {
      const score = stringSimilarity(normalizedInput, key);
      if (score > 0.6 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { key, value, score };
      }
    }
    
    if (bestMatch) {
      elizaLogger.info('info', `Fuzzy match found: ${normalizedInput} ~ ${bestMatch.key} (score: ${bestMatch.score.toFixed(2)})`);
      return bestMatch.value;
    }
    
    log('warn', `No match found for cooperative: ${input}`);
    return null;
  }
  // Simple string similarity function
function stringSimilarity(a: string, b: string): number {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length <= b.length ? a : b;
    const longerLength = longer.length;
    
    if (longerLength === 0) return 1.0;
    
    return (longerLength - editDistance(longer, shorter)) / longerLength;
  }
  // Levenshtein distance for similarity
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
  
  
 // Enhanced getAuthState with better error handling and defaults
async function getAuthState(runtime: IAgentRuntime, roomId: UUID): Promise<any> {
  elizaLogger.debug('debug', `Getting auth state for room: ${roomId}`);
  
  try {
    const memories = await runtime.databaseAdapter.getMemories({
      roomId: roomId,
      tableName: AUTH_STATE_TABLE,
      agentId: runtime.agentId,
      count: 1,
      unique: true
    });
    
    if (memories.length > 0) {
      elizaLogger.debug('debug', `Found auth state for room ${roomId}:`, memories[0].content);
      return memories[0].content;
    } else {
      const defaultState = { 
        status: AuthState.NEED_COOPERATIVE,
        roomId // Include roomId for convenience
      };
      elizaLogger.debug('debug', `No auth state found for room ${roomId}, returning default state`);
      return defaultState;
    }
  } catch (error) {
    elizaLogger.error('error', `Error getting auth state for room ${roomId}:`, error);
    return { 
      status: AuthState.NEED_COOPERATIVE,
      roomId,
      error: error.message
    };
  }
}

// Enhanced setAuthState with better error handling
async function setAuthState(runtime: IAgentRuntime, roomId: UUID, stateData: any): Promise<void> {
  elizaLogger.debug('debug', `Setting auth state for room ${roomId}:`, {
    ...stateData,
    token: stateData.token ? '[REDACTED]' : undefined,
    otp: stateData.otp ? '[REDACTED]' : undefined,
    credentials: stateData.credentials ? {
      email: stateData.credentials.email ? maskEmail(stateData.credentials.email) : undefined,
      employee_number: stateData.credentials.employee_number
    } : undefined
  });
  
  try {
    // Add roomId to state data for reference
    const updatedStateData = {
      ...stateData,
      roomId,
      updatedAt: new Date().toISOString()
    };
    
    const memoryId = uuidv4() as UUID;
    
    const memory: Memory = {
      id: memoryId,
      roomId: roomId,
      userId: runtime.agentId,
      agentId: runtime.agentId,
      createdAt: Date.now(),
      content: updatedStateData,
    };
    
    await runtime.databaseAdapter.createMemory(memory, AUTH_STATE_TABLE, true);
    elizaLogger.debug('debug', `Successfully set auth state for room ${roomId}`);
  } catch (error) {
    elizaLogger.error('error', `Error setting auth state for room ${roomId}:`, error);
    throw error; // Re-throw to handle at call site
  }
}
  
  // Helper function to check if user is in auth flow
  async function isUserInAuthFlow(runtime: IAgentRuntime, roomId: UUID): Promise<boolean> {
    const state = await getAuthState(runtime, roomId);
    const isInFlow = state.status !== AuthState.AUTHENTICATED && state.status !== undefined;
    
    elizaLogger.debug('debug', `User in room ${roomId} is in auth flow: ${isInFlow}, auth state: ${state.status}`);
    return isInFlow;
  }
  
  // Helper functions for authentication
  async function handleCooperativeSelection(
    runtime: IAgentRuntime, 
    message: Memory, 
    authState: any,
    callback: HandlerCallback
  ): Promise<boolean> {
    const text = message.content.text.toLowerCase();
    
    elizaLogger.info('info', `Handling cooperative selection for message: "${text}"`);
    
    // Direct check for known cooperatives in the message first
    for (const [key, value] of Object.entries(COOPERATIVE_MAP)) {
      if (text.includes(key.toLowerCase())) {
        elizaLogger.info('info', `Found cooperative directly in message: ${key}`);
        
        await setAuthState(runtime, message.roomId, {
          ...authState,
          status: AuthState.NEED_CREDENTIALS,
          cooperative: value,
          originalCoopName: key
        });
        
        await callback({
          text: `Thank you! I've identified you as a member of ${key}. Please provide your email address and employee number so I can verify your identity.`
        });
        
        return true;
      }
    }
    
    // If no direct match, try the LLM extraction approach
    const context = `
  Extract the cooperative name from the following user message. Only respond with the exact cooperative name.
  If no cooperative name is mentioned, respond with "UNKNOWN".
  
  Available cooperatives are: ${Object.keys(COOPERATIVE_MAP).join(', ')}
  
  User message: "${text}"
    `;
    
    elizaLogger.debug('debug', `Generating text for cooperative extraction with context: ${context}`);
    
    const cooperativeName = await generateText({
      runtime,
      context,
      modelClass: ModelClass.SMALL,
      stop: ["\n"],
    });
    
    elizaLogger.info('info', `Extracted cooperative name: "${cooperativeName}"`);
    
    const normalizedCooperativeName = cooperativeName.trim().toUpperCase();
    const tenantId = COOPERATIVE_MAP[normalizedCooperativeName];
    
    if (tenantId) {
      elizaLogger.info('info', `Successfully identified cooperative: "${normalizedCooperativeName}" -> ${tenantId}`);
      
      await setAuthState(runtime, message.roomId, {
        ...authState,
        status: AuthState.NEED_CREDENTIALS,
        cooperative: tenantId,
        originalCoopName: normalizedCooperativeName
      });
      
      await callback({
        text: `Thank you! I've identified you as a member of ${normalizedCooperativeName}. Please provide your email address and employee number so I can verify your identity.`
      });
      
      return true;
    }
    
    // If all else fails, ask the user to specify from the list
    log('warn', `Failed to identify cooperative: "${cooperativeName}"`);
    
    // Display only a subset of cooperatives as examples
    const exampleCoops = Object.keys(COOPERATIVE_MAP).slice(0, 5).join(', ');
    
    await callback({
      text: `I couldn't identify which cooperative you're referring to. Please specify which cooperative you belong to, for example: ${exampleCoops}, etc.`
    });
    
    return true;
  }
  // Function to reset auth state for a room
async function resetAuthState(runtime: IAgentRuntime, roomId: UUID): Promise<void> {
  elizaLogger.info('info', `Resetting auth state for room ${roomId}`);
  
  try {
    // Option 1: Using your existing setAuthState function with empty state
    await setAuthState(runtime, roomId, {
      status: AuthState.NEED_COOPERATIVE,
      resetAt: new Date().toISOString()
    });
    
    // Option 2: If your database allows direct deletion, which is cleaner
    // await runtime.databaseAdapter.removeAllMemories({
    //   roomId: roomId,
    //   tableName: AUTH_STATE_TABLE
    // });
    
    elizaLogger.info('info', `Successfully reset auth state for room ${roomId}`);
  } catch (error) {
    elizaLogger.error('error', `Error resetting auth state for room ${roomId}:`, error);
    throw error;
  }
}

// Enhanced handleCredentialsCollection with better user experience
async function handleCredentialsCollection(
  runtime: IAgentRuntime, 
  message: Memory, 
  authState: any,
  callback: HandlerCallback
): Promise<boolean> {
  const text = message.content.text;
  
  elizaLogger.info('info', `Handling credentials collection for room ${message.roomId}`);
  elizaLogger.debug('debug', `Message text: "${text}"`);
  
  // Enhanced context for better extraction
  const context = `
Extract the email and employee number from the following user message.
The email should be a valid email format (user@domain.com).
The employee number is typically in formats like: FUS00005, NSCDC123, etc.
Respond in strict JSON format ONLY: {"email": string, "employee_number": string}
If either field is missing or invalid, set it to null.

Examples:
- "my email is test@example.com and ID is FUS123" => {"email": "test@example.com", "employee_number": "FUS123"}
- "here's my info: FUS00005 test@coop.com" => {"email": "test@coop.com", "employee_number": "FUS00005"}
- "email: user@test.com" => {"email": "user@test.com", "employee_number": null}

User message: "${text}"
  `;
  
  elizaLogger.debug('debug', `Generating text for credentials extraction`);
  
  let extractionResult;
  try {
    extractionResult = await generateText({
      runtime,
      context,
      modelClass: ModelClass.SMALL,
    });
    
    // Clean the JSON string (remove markdown code blocks if present)
    const cleanedResult = extractionResult.replace(/```json|```/g, '').trim();
    elizaLogger.debug('debug', `Cleaned extraction result: ${cleanedResult}`);
    extractionResult = cleanedResult;
  } catch (error) {
    elizaLogger.error('error', 'Error during credentials extraction', error);
    await callback({
      text: "I had trouble understanding your credentials. Please provide your details in this format: 'Email: your@email.com, Employee #: ABC123'"
    });
    return true;
  }
  
  let credentials;
  try {
    credentials = JSON.parse(extractionResult);
    elizaLogger.info('info', `Parsed credentials - Email: ${maskEmail(credentials.email)}, Employee #: ${credentials.employee_number}`);
  } catch (error) {
    elizaLogger.error('error', 'Error parsing credentials JSON', {
      error: error.message,
      extractionResult
    });
    
    await callback({
      text: "I couldn't properly extract your information. Please provide both your email and employee number clearly, like this:\n\nEmail: your@email.com\nEmployee #: ABC12345"
    });
    return true;
  }
  
 // Check if we already have partial credentials from a previous message
 if (authState.partialCredentials) {
  credentials = {
    email: credentials.email || authState.partialCredentials.email,
    employee_number: credentials.employee_number || authState.partialCredentials.employee_number
  };
}

// Store partial credentials in auth state
const hasCompleteCredentials = credentials.email && isValidEmail(credentials.email) && credentials.employee_number;

if (!hasCompleteCredentials) {
  // Update the auth state with the partial credentials
  await setAuthState(runtime, message.roomId, {
    ...authState,
    partialCredentials: credentials
  });
  
  // Handle missing email
  if (!credentials.email || !isValidEmail(credentials.email)) {
    log('warn', `Invalid or missing email: ${credentials.email}`);
    
    // Use LLM to generate a more natural response context
    const responseContext = `
Create a friendly response asking the user for their email address. 
The user has provided some information but is missing a valid email address.
Keep it conversational and brief.
    `;
    
    const response = await generateText({
      runtime,
      context: responseContext,
      modelClass: ModelClass.SMALL,
    });
    
    await callback({
      text: response || "I'll need your email address to continue. Could you please provide it?"
    });
    
    return true;
  }
  
  // Handle missing employee number
  if (!credentials.employee_number) {
    log('warn', `Missing employee number`);
    
    // Use LLM to generate a more natural response context
    const responseContext = `
Create a friendly response asking the user for their employee number.
The user has provided their email (${maskEmail(credentials.email)}) but not their employee number.
Mention that this is needed to verify their identity within the ${authState.originalCoopName || "cooperative"} system.
Keep it conversational and brief.
    `;
    
    const response = await generateText({
      runtime,
      context: responseContext,
      modelClass: ModelClass.SMALL,
    });
    
    await callback({
      text: response || "I also need your employee number to verify your identity. Could you provide that as well?"
    });
    
    return true;
  }
}
  
  // Proceed with authentication
  try {
    const apiUrl = `https://api.techfsn.com/api/bot/authenticate-client`;
    const requestBody = {
      email: credentials.email,
      employee_number: credentials.employee_number,
      tenant: authState.cooperative
    };
    
    elizaLogger.info('info', `Authenticating user with API`, {
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
    
    elizaLogger.info('info', `Auth API response status: ${response.status}`);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: "Authentication failed" }));
      elizaLogger.error('error', `Auth API error: ${response.status} - ${errorData.message || 'Unknown error'}`);
      
      // Give a specific error message based on the status code
      let errorMessage = "I couldn't authenticate you with the provided information. ";
      
      if (response.status === 404) {
        errorMessage += "The employee details you provided weren't found in our records. Please check and try again.";
      } else if (response.status === 401) {
        errorMessage += "Your credentials seem invalid. Please verify your email and employee number.";
      } else {
        errorMessage += "Please verify your details and try again.";
      }
      
      await callback({ text: errorMessage });
      return true;
    }
    
    const data = await response.json();
    elizaLogger.debug('debug', `Auth API parsed response:`, data);
    
    // Validate the response contains required fields
    if (!data.data.otp || !data.data.token) {
      elizaLogger.error('error', 'API response missing required fields', data);
      throw new Error('Invalid API response - missing OTP or token');
    }
    
    elizaLogger.info('info', `Authentication successful, OTP generated`);
    
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
      text: `An OTP verification code has been sent to your email ${maskedEmail}. Please check your inbox and provide the 6-digit code to verify your identity.`
    });
    
    return true;
  } catch (error) {
    // elizaLogger.error('error', 'Authentication API error', {
    //   error: error.message,
    //   stack: error.stack
    // });

    elizaLogger.error('Error during authentication', error);
    
    // await setAuthState(runtime, message.roomId, {
    //   ...authState,
    //   status: AuthState.NEED_CREDENTIALS,
    //   lastError: error.message,
    //   lastAttempt: new Date().toISOString()
    // });
    
    await callback({
      text: "I encountered an error during authentication. Please try providing your email and employee number again. Make sure they're correct and associated with your cooperative account."
    });
    
    return true;
  }
}

// Enhanced OTP verification with better UX
async function handleOTPVerification(
  runtime: IAgentRuntime, 
  message: Memory, 
  authState: any,
  callback: HandlerCallback
): Promise<boolean> {
  const text = message.content.text.trim();
  
  elizaLogger.info('info', `Handling OTP verification for room ${message.roomId}`);
  elizaLogger.info('info', `OTP message text: "${text}"`);
  
  // Skip OTP extraction if the message is already just a numeric code
  let extractedOTP = text;
  if (!/^\d+$/.test(text)) {
    const context = `
Extract the OTP (numerical code) from the following user message.
Respond with just the numbers, nothing else.
If no OTP is found, respond with "NO_OTP".

User message: "${text}"
    `;
    
    extractedOTP = await generateText({
      runtime,
      context,
      modelClass: ModelClass.SMALL,
      stop: ["\n"],
    });
  }
  
  elizaLogger.info('info', `OTP processing: raw="${text}", extracted="${extractedOTP}"`);
  
  if (extractedOTP === "NO_OTP" || !extractedOTP.match(/^\d+$/)) {
    elizaLogger.info('info', `Invalid OTP format: "${extractedOTP}"`);
    
    await callback({
      text: "I couldn't identify a valid verification code in your message. Please enter only the 6-digit numerical code sent to your email."
    });
    return true;
  }
  
  if (extractedOTP === authState.otp) {
    elizaLogger.info('info', `OTP verification successful for room ${message.roomId}`);
    
    await setAuthState(runtime, message.roomId, {
      ...authState,
      status: AuthState.AUTHENTICATED,
      verifiedAt: new Date().toISOString()
    });
    
    // Check if there's a post-auth action to perform
    if (authState.postAuthAction === "CHECK_LOAN") {
      elizaLogger.info('info', `Proceeding with loan info check after successful authentication`);
      
      await callback({
        text: "You've been successfully authenticated! I'll now check your loan information."
      });
      
      // Trigger the loan check
      const loanInfoType = await determineLoanInfoType(runtime, "loan information");
      const apiUrl = `https://api.techfsn.com/api/bot/client-loan-info?tenant=${authState.cooperative}&employee_number=${authState.credentials.employee_number}`;
      
      elizaLogger.info('info', `Fetching loan info from ${apiUrl} after authentication`);
      
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
        
        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }
        
        const loanData = await response.json();
        const formattedResponse = await formatLoanResponse(runtime, loanData, loanInfoType);
        
        await callback({
          text: formattedResponse
        });
      } catch (error) {
        elizaLogger.error('error', 'Error fetching loan info after authentication', error);
        
        await callback({
          text: "I authenticated you successfully, but encountered an issue retrieving your loan information. Please ask me about your loan again, and I'll try once more."
        });
      }
    } else {
      await callback({
        text: "Authentication successful! You're now logged in and can check your loan information or perform other account-related actions. How can I help you today?"
      });
    }
    
    return true;
  } else {
    elizaLogger.warn('warn', `OTP verification failed: provided="${extractedOTP}", expected="${authState.otp}"`);
    
    await callback({
      text: "The verification code you provided doesn't match what we sent. Please check your email and try again. If you don't see it, check your spam folder."
    });
    
    return true;
  }
}

// Main authentication handler function
async function handleAuthentication(runtime: IAgentRuntime, message: Memory, state: State, callback: HandlerCallback): Promise<boolean> {
  const roomId = message.roomId;
  const userId = message.userId;
  
  elizaLogger.info('info', `Handling authentication for room ${roomId}, user ${userId}`);
  const authState = await getAuthState(runtime, roomId);
  elizaLogger.info('info', `Current auth state: ${authState.status}`);
  
  // CRITICAL: Skip OTP handling in this handler
  if (authState.status === AuthState.NEED_OTP && /^\d+$/.test(message.content.text.trim())) {
    elizaLogger.info('info', `Skipping OTP handling in authenticateAction - deferring to VERIFY_OTP action`);
    return false;
  }
  // In handleAuthentication for FAILED state:
if (authState.status === AuthState.FAILED) {
  elizaLogger.info('info', `Resetting failed auth state`);
  
  const context = `
Generate a friendly response to a user whose authentication has failed.
Let them know we're going to try again and ask which cooperative they belong to.
Suggest they can also say "reset" or "start over" if they want to try again with a fresh start.
Keep it conversational and helpful.
  `;
  
  const response = await generateText({
    runtime,
    context,
    modelClass: ModelClass.SMALL,
  });
  
  await setAuthState(runtime, roomId, { 
    status: AuthState.NEED_COOPERATIVE,
    userId,
    postAuthAction: authState.postAuthAction // Preserve the post-auth action
  });
  
  await callback({
    text: response || "Let's try authenticating again. Which cooperative do you belong to? If you'd like to start fresh, just say 'reset' or 'start over'."
  });
  
  return true;
}
  

  
  // Normal auth flow based on state
  switch(authState.status) {
    case AuthState.NEED_COOPERATIVE:
      elizaLogger.info('info', `Starting cooperative selection flow`);
      return await handleCooperativeSelection(runtime, message, authState, callback);
      
    case AuthState.NEED_CREDENTIALS:
      elizaLogger.info('info', `Starting credentials collection flow`);
      return await handleCredentialsCollection(runtime, message, authState, callback);
      
      case AuthState.NEED_OTP:
        // No longer handling OTP here - let the dedicated action handle it
        elizaLogger.info('info', `Deferring OTP handling to VERIFY_OTP action`);
        await callback({
          text: "Please enter the 6-digit verification code sent to your email."
        });
        return true;
      
    case AuthState.AUTHENTICATED:
      elizaLogger.info('info', `User is already authenticated`);
      // Check if there's a pending post-auth action
      if (authState.postAuthAction) {
        elizaLogger.info('info', `Executing pending post-auth action: ${authState.postAuthAction}`);
        return await handlePostAuthAction(runtime, authState, callback);
      }
      
      await callback({
        text: "You're already authenticated! How can I help you today? You can check your loan information or other account details."
      });
      return true;
      
    case AuthState.FAILED:
      elizaLogger.info('info', `Resetting failed auth state`);
      await setAuthState(runtime, roomId, { 
        status: AuthState.NEED_COOPERATIVE,
        userId,
        postAuthAction: authState.postAuthAction // Preserve the post-auth action
      });
      await callback({
        text: "Let's try authenticating again. Which cooperative do you belong to?"
      });
      return true;
      
    default:
      elizaLogger.info('info', `Starting new auth flow`);
      await setAuthState(runtime, roomId, { 
        status: AuthState.NEED_COOPERATIVE,
        userId
      });
      await callback({
        text: "To help you, I'll need to authenticate you first. Which cooperative do you belong to? (e.g., Fusion, CTLS, Octics)"
      });
      return true;
  }
}

   // Helper function to validate email format
  function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
  
  // -------- ACTIONS DEFINITIONS --------
  
const authenticateAction: Action = {
  name: "AUTHENTICATE_USER",
  description: "Handles user authentication to access cooperative services",
  similes: [
    "LOGIN", "VERIFY_USER", "AUTH", "AUTHENTICATE", "SIGN IN", 
    "VERIFY ME", "CHECK ACCOUNT", "ACCESS ACCOUNT", "VALIDATE USER",
    "CONFIRM IDENTITY", "AUTHENTICATION", "LOG ME IN", "VERIFY ACCOUNT"
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    // Check if user is already in auth flow
    const text = message.content.text.trim();
    
    // NEVER handle pure numeric input with authenticate action
    if (/^\d+$/.test(text)) {
      elizaLogger.info('info', `AUTHENTICATE_USER rejecting numeric input: "${text}"`);
      return false;
    }
    const authState = await getAuthState(runtime, message.roomId);
    if (authState.status !== AuthState.AUTHENTICATED && 
      authState.status !== undefined) {
    
    // If we're in NEED_OTP state and the message is numeric,
    // let the dedicated OTP action handle it
    if (authState.status === AuthState.NEED_OTP && 
        /^\d+$/.test(message.content.text.trim())) {
      elizaLogger.debug('debug', `Message appears to be an OTP code, deferring to OTP action`);
      return false;
    }
    
    elizaLogger.debug('debug', `User is in auth flow (${authState.status}), continuing authentication`);
    return true;
  }
    const isInAuthFlow = authState.status !== AuthState.AUTHENTICATED && 
                         authState.status !== undefined;
    
    if (isInAuthFlow) {
      elizaLogger.debug('debug', `User is in auth flow (${authState.status}), continuing authentication`);
      return true;
    }
    
    // If not in flow, only trigger on explicit auth requests
    const authKeywords = [
      "login", "authenticate", "verify", "identity", "sign in", 
      "credentials", "account access"
    ];
    
    const containsAuthKeyword = authKeywords.some(keyword => 
      text.includes(keyword) || 
      new RegExp(`\\b${keyword}\\b`).test(text)
    );

    // Additional check to avoid conflicting with CHECK_LOAN action
    // If message contains loan keywords and auth keywords, don't trigger auth action
    // as the loan action will handle authentication
    const loanKeywords = ["loan", "borrow", "credit", "payment", "balance"];
    const containsLoanKeyword = loanKeywords.some(keyword => 
      text.includes(keyword) || 
      new RegExp(`\\b${keyword}\\b`).test(text)
    );
    if (containsLoanKeyword && containsAuthKeyword) {
      elizaLogger.debug('debug', `Message contains both loan and auth keywords, deferring to CHECK_LOAN action`);
      return false;
    }
    
    
    elizaLogger.debug('debug', `Message contains explicit auth keywords: ${containsAuthKeyword}`);
    return containsAuthKeyword;
  },
  
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options, callback: HandlerCallback) => {
    return await handleAuthentication(runtime, message, state, callback);
  },
  
  examples: [
    // Example conversations for when users explicitly want to authenticate
    [
      {
        user: "{{user1}}",
        content: {
          text: "I need to login to my cooperative account"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I'll help you authenticate. Which cooperative do you belong to?",
          action: "AUTHENTICATE_USER"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "How do I verify my identity?"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I can help you authenticate with your cooperative. Which cooperative do you belong to?",
          action: "AUTHENTICATE_USER"
        }
      }
    ]
  ],

};
// ------------ RESET ACTION ---------
// Reset Action for debugging/testing
const resetAction: Action = {
  name: "RESET_AUTH",
  description: "Reset authentication state and start fresh",
  similes: [
    "RESTART", 
    "START_OVER", 
    "RESET", 
    "CLEAR", 
    "REFRESH", 
    "BEGIN_AGAIN",
    "NEW_CONVERSATION",
    "START_FRESH",
    "LOG_OUT",
    "SIGN_OUT",
    "FORGET_ME",
    "START_ANEW",
    "WIPE_SESSION",
    "CLEAN_SLATE"
  ],  
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    
    const resetKeywords = [
      "reset", "restart", "start over", "clear", "begin again", 
      "start fresh", "start new", "new session", "log out", "sign out",
      "forget me", "clean slate", "wipe", "from scratch", "re-do",
      "try again from beginning", "reboot", "fresh start"
    ];
    
    const isResetCommand = resetKeywords.some(keyword => 
      text.includes(keyword) || 
      new RegExp(`\\b${keyword}\\b`).test(text)
    );
    
    return isResetCommand;
  },
  
  handler: async (runtime: IAgentRuntime, message: Memory, _state: State, _options, callback: HandlerCallback) => {
    await resetAuthState(runtime, message.roomId);
    
    // Generate a more natural response
    const resetContext = `
Generate a friendly response letting the user know you've reset their session and authentication data.
Let them know they can start fresh and ask about their cooperative account or loan information.
Keep it conversational and brief.
    `;
    
    const resetResponse = await generateText({
      runtime,
      context: resetContext,
      modelClass: ModelClass.SMALL,
    });
    
    await callback({
      text: resetResponse || "I've reset our conversation. Let's start fresh! If you need help with your cooperative account or loan information, just let me know."
    });
    
    return true;
  },
    
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Reset our conversation"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I've reset our conversation. Let's start fresh! If you need help with your cooperative account or loan information, just let me know.",
          action: "RESET_AUTH"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "I want to start over"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "No problem! I've cleared our previous session data. We can begin again whenever you're ready.",
          action: "RESET_AUTH"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Can we start from scratch please?"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "Absolutely! I've reset everything and we're starting with a clean slate now. How can I help you today?",
          action: "RESET_AUTH"
        }
      }
    ]
  ]
};

// Post-Authentication Action Handler
async function handlePostAuthAction(runtime: IAgentRuntime, authState: any, callback: HandlerCallback): Promise<boolean> {
  if (!authState.postAuthAction) {
    return false;
  }
  
  elizaLogger.info('info', `Handling post-auth action: ${authState.postAuthAction}`);
  
  switch (authState.postAuthAction) {
    case "CHECK_LOAN":
      // Logic to fetch and display loan info
      try {
        const loanInfoType = "DETAILS"; // Default to general details
        const apiUrl = `https://api.techfsn.com/api/bot/client-loan-info?tenant=${authState.cooperative}&employee_number=${authState.credentials.employee_number}`;
        
        elizaLogger.info('info', `Executing post-auth loan check: ${apiUrl}`);
        
        const response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${authState.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'fsn-hash': FSN_HASH
          }
        });
        
        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }
        
        const loanData = await response.json();
        const formattedResponse = await formatLoanResponse(runtime, loanData, loanInfoType);
        
        await callback({
          text: formattedResponse
        });
        
        // Clear the post-auth action
        await setAuthState(runtime, authState.roomId, {
          ...authState,
          postAuthAction: null
        });
        
        return true;
      } catch (error) {
        elizaLogger.error('error', 'Error executing post-auth loan check', error);
        
        await callback({
          text: "I authenticated you successfully, but encountered an issue retrieving your loan information. Please ask me about your loan again, and I'll try once more."
        });
        
        return true;
      }
      
    // Add other post-auth actions as needed
    
    default:
      return false;
  }
}
  
  // Loan Info Action
 // Loan Info Action
const loanInfoAction: Action = {
  name: "CHECK_LOAN",
  description: "Check loan information for a user, initiating authentication if needed",
  similes: [
    "LOAN_INFO", 
    "LOAN_STATUS", 
    "CHECK_LOAN_INFO", 
    "GET_LOAN_STATUS", 
    "LOAN_BALANCE", 
    "LOAN_DETAILS",
    "MY_LOAN",
    "VIEW_LOAN",
    "LOAN_PAYMENT",
    "PAYMENT_INFO",
    "REPAYMENT_SCHEDULE",
    "REPAYMENT_STATUS",
    "LOAN_AMOUNT",
    "LOAN_INTEREST",
    "LOAN_DURATION",
    "LOAN_TERM",
    "LOAN_APPLICATION",
    "OUTSTANDING_BALANCE",
    "DEBT_INFO",
    "REMAINING_BALANCE",
    "NEXT_PAYMENT"
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    
    elizaLogger.debug('debug', `Validating loan info action for message: "${text}"`);
     // IMMEDIATE REJECTION: If it's a numeric code, NEVER handle with loan action
     if (/^\d+$/.test(text)) {
      elizaLogger.info('info', `CHECK_LOAN rejecting numeric input: "${text}"`);
      return false;
    }

    // CRITICAL: Check if this appears to be an OTP code - if so, NEVER handle it
    if (/^\d+$/.test(text.trim())) {
      // Get auth state to check if we're in OTP verification
      try {
        const authState = await getAuthState(runtime, message.roomId);
        if (authState.status === AuthState.NEED_OTP) {
          elizaLogger.warn('warn', `Message appears to be an OTP code during OTP verification stage, REJECTING loan action`);
          return false;
        }
      } catch (error) {
        // If we can't check auth state, err on the side of caution with numeric inputs
        elizaLogger.error('error', `Error checking auth state for numeric input, rejecting loan action:`, error);
        return false;
      }
    }

    // Check if user is already in any auth flow stage - if so, don't trigger this action
    try {
      const authState = await getAuthState(runtime, message.roomId);
      if (authState.status !== AuthState.AUTHENTICATED && 
          authState.status !== undefined) {
        elizaLogger.debug('debug', `User is in auth flow (${authState.status}), not triggering loan action`);
        return false;
      }
    } catch (error) {
      elizaLogger.error('error', `Error checking auth state, assuming not in auth flow:`, error);
      // Continue validation if we can't check auth state
    }
    
    // Rest of validation remains the same...
    const loanKeywords = [
      "loan", "borrow", "credit", "debt", "owe", "payment", 
      "balance", "due", "repayment", "interest", "principal",
      "check my", "view my", "show my", "get my", "tell me about my"
    ];
    
    const isLoanRelated = loanKeywords.some(keyword => 
      text.includes(keyword) || 
      new RegExp(`\\b${keyword}\\b`).test(text)
    );
    
    elizaLogger.debug('debug', `Message is loan related: ${isLoanRelated}`);
    return isLoanRelated;
  },
  
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: {[key: string]: unknown}, callback: HandlerCallback) => {
    elizaLogger.info('info', `Handling loan info action for room ${message.roomId}`);
    
    try {
      // Check if user is authenticated
      const authState = await getAuthState(runtime, message.roomId);
      
      // If not authenticated, start authentication flow
      if (authState.status !== AuthState.AUTHENTICATED) {
        elizaLogger.info('info', `User not authenticated, initiating auth flow for loan request`);

        elizaLogger.info('User not authenticated, initiating auth flow for loan request');
        elizaLogger.info(authState)
        
        await callback({
          text: "To check your loan information, I'll need to verify your identity first. Which cooperative do you belong to? (e.g., Fusion, CTLS, Octics)"
        });
        
        // Set state to start authentication flow
        await setAuthState(runtime, message.roomId, {
          status: AuthState.NEED_COOPERATIVE,
          userId: message.userId,
          postAuthAction: "CHECK_LOAN" // Set the action to perform after auth
        });
        
        return true;
      }
      
      // User is authenticated, get loan info
      elizaLogger.info('info', `User is authenticated, fetching loan info`);
      
      const loanInfoType = await determineLoanInfoType(runtime, message.content.text);
      elizaLogger.info('info', `Determined loan info type: ${loanInfoType}`);
      
      const apiUrl = `https://api.techfsn.com/api/bot/client-loan-info?tenant=${authState.cooperative}&employee_number=${authState.credentials.employee_number}`;
      
      elizaLogger.info('info', `Fetching loan info from ${apiUrl}`);
      
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
      
      elizaLogger.info('info', `Loan API response status: ${response.status}`);
      
      if (!response.ok) {
        // Handle token expiration
        if (response.status === 401) {
          elizaLogger.info('info', 'Token expired, restarting authentication flow');
          
          const errorResponse = await generateAuthErrorResponse(runtime, response.status);
    
          await callback({
            text: errorResponse
          });
          
          await setAuthState(runtime, message.roomId, {
            status: AuthState.NEED_COOPERATIVE,
            userId: message.userId,
            postAuthAction: "CHECK_LOAN",
            lastError: `API returned ${response.status}`
          });
          
              
          
          
          return true;
        }
        if(response.status === 403) {
          elizaLogger.error('error', 'Loan API error: 403 - Token expired');
          const errorResponse = await generateAuthErrorResponse(runtime, response.status);
          await callback({
            text: errorResponse
          });
          await setAuthState(runtime, message.roomId, {
            status: AuthState.NEED_COOPERATIVE,
            userId: message.userId,
            postAuthAction: "AUTHENTICATE_USER",
            lastError: `API returned ${response.status}`
          });

        }
        
        const errorText = await response.text();
        elizaLogger.error('error', `Loan API error: ${response.status} - ${errorText}`);
        throw new Error(`Failed to fetch loan info: ${response.statusText}`);
      }
      
      const responseText = await response.text();
      let loanData;
      try {
        loanData = JSON.parse(responseText);
        elizaLogger.debug('debug', `Loan API parsed response:`, loanData);
      } catch (e) {
        elizaLogger.error('error', `Failed to parse loan data JSON: ${e.message}`);
        throw new Error(`Invalid JSON response: ${responseText}`);
      }
      
      const formattedResponse = await formatLoanResponse(runtime, loanData, loanInfoType);
      elizaLogger.info('LOAN INFO: ', responseText);


      elizaLogger.info('LOAN INFO: ', formattedResponse);
      
      await callback({
        text: formattedResponse
      });
      
      return true;
    } catch (error) {
      elizaLogger.error('error', 'Error fetching loan information', error);
      
      await callback({
        text: "I encountered an error while retrieving your loan information. Let me try again. Which cooperative do you belong to?"
      });
      
      await setAuthState(runtime, message.roomId, {
        status: AuthState.NEED_COOPERATIVE,
        userId: message.userId,
        postAuthAction: "CHECK_LOAN",
        lastError: error.message
      });
      
      return true;
    }
  },
  
  examples: [
    // Examples of loan-related conversations
    [
      {
        user: "{{user1}}",
        content: {
          text: "Can you tell me about my loan status?"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "To check your loan information, I'll need to verify your identity first. Which cooperative do you belong to?",
          action: "CHECK_LOAN"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "What's my current loan balance?"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "To check your loan balance, I'll need to verify your identity first. Which cooperative do you belong to?",
          action: "CHECK_LOAN"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "When is my next payment due?"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I'll need to check your loan payment schedule. First, could you tell me which cooperative you're with?",
          action: "CHECK_LOAN"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "How much interest have I paid so far?"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I'd be happy to check your interest payments. To access that information, I'll first need to verify your identity. Which cooperative are you with?",
          action: "CHECK_LOAN"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "I'd like to understand my repayment structure"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I can help you understand your loan repayment structure. First, I'll need to authenticate you. Which cooperative do you belong to?",
          action: "CHECK_LOAN"
        }
      }
    ]
  ]
};
  
  // Helper functions for loan action
// Improved function to determine loan info type from user message
async function determineLoanInfoType(runtime: IAgentRuntime, message: string): Promise<string> {
  elizaLogger.debug('debug', `Determining loan info type for message: "${message}"`);
  
  const context = `
Determine what specific loan information the user is asking about from their message.
Respond with one of the following categories ONLY (no explanation):
- STATUS (if asking about approval status, pending, etc.)
- AMOUNT (if asking about loan amount, balance, etc.)
- PAYMENT (if asking about payments, due dates, etc.)
- ELIGIBILITY (if asking about qualification, can they get a loan, etc.)
- HISTORY (if asking about past loans, loan history, etc.)
- DETAILS (for any general loan information)

Examples:
- "What's the status of my loan?" -> STATUS
- "How much do I owe?" -> AMOUNT
- "When is my next payment due?" -> PAYMENT
- "Can I apply for another loan?" -> ELIGIBILITY
- "Show me my previous loans" -> HISTORY
- "Tell me about my loan" -> DETAILS

User message: "${message}"
  `;
  
  const loanInfoType = await generateText({
    runtime,
    context,
    modelClass: ModelClass.SMALL,
    stop: ["\n"],
  });
  
  // Validate the response is one of the expected types
  const validTypes = ["STATUS", "AMOUNT", "PAYMENT", "ELIGIBILITY", "HISTORY", "DETAILS"];
  const normalizedType = loanInfoType.trim().toUpperCase();
  
  if (!validTypes.includes(normalizedType)) {
    log('warn', `Invalid loan info type returned: "${loanInfoType}", defaulting to DETAILS`);
    return "DETAILS";
  }
  
  elizaLogger.debug('debug', `Determined loan info type: ${normalizedType}`);
  return normalizedType;
}

// Enhanced response formatting with better error handling
async function formatLoanResponseWithErrorHandling(runtime: IAgentRuntime, loanData: any, infoType: string): Promise<string> {
  try {
    return await formatLoanResponse(runtime, loanData, infoType);
  } catch (error) {
    elizaLogger.error('error', 'Error formatting loan response', error);
    
    // Return a generic response when formatting fails
    return "I was able to retrieve your loan information, but encountered an issue formatting the details. " +
           "Here's what I know: You " + 
           (loanData && Object.keys(loanData).length > 0 ? "have active loan information in our system. " : 
           "don't appear to have any active loans in our system. ") +
           "If you have specific questions about your loan, please ask and I'll try to provide more details.";
  }
}
  
/**
 * Formats loan data into a user-friendly response based on the type of information requested
 * 
 * @param runtime The agent runtime
 * @param loanData The loan data from the API
 * @param infoType The type of information requested (STATUS, AMOUNT, PAYMENT, etc.)
 * @returns A formatted string response
 */
async function formatLoanResponse(runtime: IAgentRuntime, loanData: any, infoType: string): Promise<string> {
  elizaLogger.debug('debug', `Formatting loan response for type: ${infoType}`);
  
  // Handle empty or missing loan data
  if (!loanData || 
      (typeof loanData === 'object' && Object.keys(loanData).length === 0) || 
      (Array.isArray(loanData) && loanData.length === 0)) {
    elizaLogger.info('info', 'No loan data available for user');
    return "I checked your account, but you don't currently have any active loans in our system. " +
           "If you believe this is incorrect or would like to inquire about loan eligibility, " +
           "please contact your cooperative's support team for assistance.";
  }
  
  try {
    // Sanitize and validate loan data to prevent errors
    const sanitizedData = sanitizeLoanData(loanData);
    elizaLogger.debug('debug', `Sanitized loan data for formatting`, sanitizedData);
    
    // Create a context based on the info type requested
    const context = `
You are a financial assistant helping a cooperative member understand their loan information.
Below is their loan data from the cooperative system:

${JSON.stringify(sanitizedData, null, 2)}

The member is specifically asking about: ${infoType}

Write a helpful, clear response that addresses their specific question. Follow these guidelines:
1. Be specific with numbers, dates, and status information
2. Format currency values with the ₦ symbol and proper formatting (e.g., ₦50,000.00)
3. Use a warm, supportive tone
4. Present dates in a readable format (e.g., "March 25, 2025" instead of ISO format)
5. If the information they're asking about isn't available, politely explain that

Based on their request type (${infoType}), focus on:
${getContextForInfoType(infoType)}

Start with a brief greeting and end with a helpful offer or suggestion.
Keep your response under 150 words, clear and focused.
`;
    
    elizaLogger.debug('debug', 'Generating formatted loan response text');
    
    const formattedResponse = await generateText({
      runtime,
      context,
      modelClass: ModelClass.LARGE,
    });
    
    elizaLogger.debug('debug', `Generated loan response (${formattedResponse.length} chars)`);
    return formattedResponse;
  } catch (error) {
    elizaLogger.error('error', 'Error formatting loan response:', error);
    
    // Fallback response that still provides some value
    return createFallbackLoanResponse(loanData, infoType);
  }
}

/**
 * Sanitizes and normalizes loan data to prevent formatting errors
 */
function sanitizeLoanData(loanData: any): any {
  // Handle array of loans
  if (Array.isArray(loanData)) {
    return loanData.map(loan => sanitizeLoanObject(loan));
  }
  
  // Handle single loan object
  return sanitizeLoanObject(loanData);
}

/**
 * Sanitizes a single loan object
 */
function sanitizeLoanObject(loan: any): any {
  if (!loan || typeof loan !== 'object') {
    return { error: "Invalid loan data" };
  }
  
  const sanitized: any = {};
  
  // Copy existing properties, ensuring they're safe
  for (const [key, value] of Object.entries(loan)) {
    // Skip null/undefined values
    if (value === null || value === undefined) continue;
    
    // Format dates when detected
    if (typeof value === 'string' && 
        (key.toLowerCase().includes('date') || key.toLowerCase().includes('time'))) {
      try {
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
          sanitized[key] = date.toISOString();
        } else {
          sanitized[key] = value;
        }
      } catch {
        sanitized[key] = value;
      }
      continue;
    }
    
    // Format amounts when detected
    if (typeof value === 'number' && 
        (key.toLowerCase().includes('amount') || 
         key.toLowerCase().includes('payment') || 
         key.toLowerCase().includes('balance'))) {
      sanitized[key] = value.toFixed(2);
      continue;
    }
    
    // Default: copy the value as is
    sanitized[key] = value;
  }
  
  return sanitized;
}

/**
 * Returns context-specific instructions based on info type
 */
function getContextForInfoType(infoType: string): string {
  switch (infoType.toUpperCase()) {
    case 'STATUS':
      return "- Loan approval status (approved, pending, denied)\n" +
             "- Current stage in the loan lifecycle\n" +
             "- Any pending requirements or actions needed";
      
    case 'AMOUNT':
      return "- Total loan amount approved\n" +
             "- Current outstanding balance\n" +
             "- Principal and interest breakdown if available";
      
    case 'PAYMENT':
      return "- Next payment due date\n" +
             "- Payment amount due\n" +
             "- Payment history summary\n" +
             "- Payment instructions if available";
      
    case 'ELIGIBILITY':
      return "- Current eligibility status for loans\n" +
             "- Eligibility criteria if available\n" +
             "- Suggestions for improving eligibility if applicable";
      
    case 'HISTORY':
      return "- Previous loan summary\n" +
             "- Payment history highlights\n" +
             "- Overall account standing";
      
    default: // DETAILS or any other type
      return "- Comprehensive overview of the loan\n" +
             "- Key dates (approval, disbursement, maturity)\n" +
             "- Current balance and payment information\n" +
             "- Interest rate and loan terms";
  }
}

/**
 * Creates a fallback response when formatting fails
 */
function createFallbackLoanResponse(loanData: any, infoType: string): string {
  try {
    // Extract some basic information that should be present in most loan data structures
    let loanAmount = "not specified";
    let loanStatus = "not specified";
    let nextPayment = "not specified";
    
    // Try to extract basic information from loan data
    if (typeof loanData === 'object') {
      // Look for amount fields
      for (const key of Object.keys(loanData)) {
        if (key.toLowerCase().includes('amount') && loanData[key]) {
          const amount = parseFloat(loanData[key]);
          if (!isNaN(amount)) {
            loanAmount = `₦${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            break;
          }
        }
      }
      
      // Look for status fields
      for (const key of Object.keys(loanData)) {
        if (key.toLowerCase().includes('status') && loanData[key]) {
          loanStatus = loanData[key].toString();
          break;
        }
      }
      
      // Look for next payment date
      for (const key of Object.keys(loanData)) {
        if ((key.toLowerCase().includes('next') && key.toLowerCase().includes('payment')) ||
            (key.toLowerCase().includes('due') && key.toLowerCase().includes('date'))) {
          if (loanData[key]) {
            try {
              const date = new Date(loanData[key]);
              if (!isNaN(date.getTime())) {
                nextPayment = date.toLocaleDateString('en-US', { 
                  year: 'numeric', 
                  month: 'long', 
                  day: 'numeric' 
                });
              } else {
                nextPayment = loanData[key].toString();
              }
            } catch {
              nextPayment = loanData[key].toString();
            }
            break;
          }
        }
      }
    }
    
    // Construct a basic response based on the info type
    const responses: Record<string, string> = {
      'STATUS': `I found your loan information. Your current loan status is ${loanStatus}.`,
      'AMOUNT': `I found your loan information. Your loan amount is ${loanAmount}.`,
      'PAYMENT': `I found your loan information. Your next payment is due on ${nextPayment}.`,
      'ELIGIBILITY': `I found your loan information. Based on your current status, please contact your cooperative for specific eligibility details.`,
      'HISTORY': `I found your loan information. Please contact your cooperative for detailed loan history.`,
      'DETAILS': `I found your loan information. Your loan amount is ${loanAmount}, with status ${loanStatus}, and next payment due on ${nextPayment}.`
    };
    
    return responses[infoType.toUpperCase()] || 
      `I found your loan information but couldn't format it in detail. I recommend contacting your cooperative's support team for specific information about your ${infoType.toLowerCase()}.`;
    
  } catch (error) {
    elizaLogger.error('error', 'Error creating fallback loan response:', error);
    
    // Ultra-fallback when everything else fails
    return "I found your loan information, but I'm having trouble formatting the details. " +
           "Please ask your cooperative's support team for specific information about your loan.";
  }
}
  // Add a new function to periodically clean up expired auth states
// Function to check if auth state is expired and should be reset
async function checkAndResetExpiredAuthState(runtime: IAgentRuntime, roomId: UUID): Promise<boolean> {
  try {
    const authState = await getAuthState(runtime, roomId);
    
    // If not in auth flow or already authenticated, nothing to reset
    if (authState.status === AuthState.AUTHENTICATED || authState.status === undefined) {
      return false;
    }
    
    // Calculate auth flow timeout based on state
    const now = Date.now();
    const updatedAt = new Date(authState.updatedAt || 0).getTime();
    let timeoutThreshold = 30 * 60 * 1000; // Default 30 minutes
    
    // Use different timeouts based on auth state
    if (authState.status === AuthState.NEED_OTP) {
      timeoutThreshold = 15 * 60 * 1000; // 15 minutes for OTP entry
    } else if (authState.status === AuthState.NEED_CREDENTIALS) {
      timeoutThreshold = 20 * 60 * 1000; // 20 minutes for credentials entry
    }
    
    // Check if the auth flow has timed out
    if (now - updatedAt > timeoutThreshold) {
      elizaLogger.info('info', `Auth flow timed out for room ${roomId}, last updated ${(now - updatedAt) / 60000} minutes ago`);
      
      // Reset to initial state
      await setAuthState(runtime, roomId, {
        status: AuthState.NEED_COOPERATIVE,
        userId: authState.userId,
        previousState: authState.status,
        timedOut: true
      });
      
      return true;
    }
    
    return false;
  } catch (error) {
    elizaLogger.error('error', `Error checking expired auth state for room ${roomId}:`, error);
    return false;
  }
}

// Enhanced cleanup function for expired auth states
async function cleanupExpiredAuthStates(runtime: IAgentRuntime) {
  try {
    elizaLogger.info('info', 'Running auth state cleanup');
    const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
    
    // This is a placeholder - implementation would depend on your database adapter capabilities
    // You would need to adapt this to your actual database operations
    elizaLogger.info('info', `Would clean up auth states older than ${new Date(cutoffTime).toISOString()}`);
    
    // Example implementation if your database adapter supports the operation:
    /*
    const result: any = await runtime.databaseAdapter.removeAllMemories({
      tableName: AUTH_STATE_TABLE,
      filter: {
        createdAt: { $lt: cutoffTime },
        'content.status': { $ne: 'AUTHENTICATED' }
      }
    });
    
    elizaLogger.info('info', `Cleaned up ${result.deletedCount} expired auth states`);
    */
  } catch (error) {
    elizaLogger.error('error', 'Error during auth state cleanup', error);
  }
}
  
  // Run cleanup every hour
setInterval(() => {
  if (typeof globalThis.runtime !== 'undefined') {
    cleanupExpiredAuthStates(globalThis.runtime);
  }
}, 60 * 60 * 1000);
  
  // -------- PROVIDERS DEFINITIONS --------
  
  // Cooperatives Provider
  const cooperativesProvider: Provider = {
    get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
      const cooperativesList = Object.keys(COOPERATIVE_MAP).map(name => `- ${name}`).join('\n');
      
      return `
  # Available Cooperatives
  The following cooperatives are currently supported:
  ${cooperativesList}
  
  # Cooperative Validation Function
  You can validate and normalize cooperative names using the function validateCooperative(input).
  If a user mentions a cooperative name like "Immigration" it will be normalized to the correct tenant ID.
      `;
    }
  };
  
  // Auth Status Provider
  const authStatusProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
      try {
        elizaLogger.debug('debug', `Getting auth status for provider in room ${message.roomId}`);
        
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
        
        let statusMessage = `# Authentication Status\n`;
        statusMessage += `Current status: ${authState.status}\n`;
        
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
      } catch (error) {
        elizaLogger.error('error', 'Error getting auth status for provider', error);
        return `Error retrieving authentication status: ${error.message}`;
      }
    }
  };
  // ===== DIRECT OTP ACTION =====
// Add this new action specifically for OTP verification to ensure it's properly handled

const verifyOTPAction: Action = {
  name: "VERIFY_OTP",
  description: "Verifies the OTP code sent to the user's email during authentication",
  similes: ["CHECK_OTP", "ENTER_OTP", "VERIFY_CODE", "CONFIRM_OTP", "VALIDATE_OTP"],
  
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.trim();
    
    // ONLY handle pure numeric messages
    if (!/^\d+$/.test(text)) {
      return false;
    }
    
    elizaLogger.info('info', `Pure numeric input detected: "${text}"`);
    
    try {
      const authState = await getAuthState(runtime, message.roomId);
      elizaLogger.info('info', `Current auth state for numeric input: ${authState.status}`);
      
      // ONLY handle if we're waiting for OTP
      if (authState.status !== AuthState.NEED_OTP) {
        elizaLogger.info('info', `Not in OTP verification state, skipping.`);
        return false;
      }
      
      elizaLogger.info('info', `✓ IN OTP VERIFICATION STATE - handling numeric input`);
      elizaLogger.info('info', `Expected OTP: ${authState.otp}, Received: ${text}`);
      
      // Guarantee this has the highest priority
      return true;
    } catch (error) {
      elizaLogger.error('error', 'Error in VERIFY_OTP validator:', error);
      return false;
    }
  },
  
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options, callback: HandlerCallback) => {
    elizaLogger.info('info', `VERIFY_OTP HANDLER EXECUTING for message: "${message.content.text}"`);
    
    try {
      const authState = await getAuthState(runtime, message.roomId);
      const enteredOTP = message.content.text.trim();
      
      elizaLogger.info('info', `Verifying OTP: entered=${enteredOTP}, expected=${authState.otp}`);
      
      if (authState.status !== AuthState.NEED_OTP) {
        elizaLogger.warn('warn', `Not in OTP verification state. Current state: ${authState.status}`);
        return false;
      }
      
      // OTP verification logic
      if (enteredOTP === authState.otp) {
        elizaLogger.info('info', `★★★ OTP VERIFICATION SUCCESSFUL ★★★`);
        
        // Update auth state to authenticated FIRST
        await setAuthState(runtime, message.roomId, {
          ...authState,
          status: AuthState.AUTHENTICATED,
          verifiedAt: new Date().toISOString()
        });
        
        elizaLogger.info('info', `Auth state updated to AUTHENTICATED`);
        
        // Check for post-auth action
        if (authState.postAuthAction === "CHECK_LOAN") {
          elizaLogger.info('info', `Executing post-auth loan check`);
          
          await callback({
            text: "You've been successfully authenticated! I'll now check your loan information."
          });
          
          const loanInfoType = await determineLoanInfoType(runtime, "loan information");
          const apiUrl = `https://api.techfsn.com/api/bot/client-loan-info?tenant=${authState.cooperative}&employee_number=${authState.credentials.employee_number}`;
          
          elizaLogger.info('info', `Fetching loan info from ${apiUrl}`);
          
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
            
            if (!response.ok) {
              throw new Error(`API error: ${response.status}`);
            }
            
            const loanData = await response.json();
            const formattedResponse = await formatLoanResponse(runtime, loanData, loanInfoType);
            
            await callback({
              text: formattedResponse
            });
          } catch (error) {
            elizaLogger.error('error', 'Error fetching loan info after OTP verification', error);
            await callback({
              text: "I authenticated you successfully, but encountered an issue retrieving your loan information. Please ask me about your loan again, and I'll try once more."
            });
          }
        } else {
          elizaLogger.info('info', `No post-auth action, sending success message`);
          await callback({
            text: "Authentication successful! You're now logged in and can check your loan information or perform other account-related actions. How can I help you today?"
          });
        }
        
        return true;
      } else {
        elizaLogger.warn('warn', `OTP verification failed: entered "${enteredOTP}", expected "${authState.otp}"`);
        
        await callback({
          text: "The verification code you provided doesn't match what we sent. Please check your email and try again. If you don't see it, check your spam folder."
        });
        
        return true;
      }
    } catch (error) {
      elizaLogger.error('error', 'Error in VERIFY_OTP handler:', error);
      
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
        content: {
          text: "123456"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "Authentication successful! You're now logged in and can check your loan information or perform other account-related actions. How can I help you today?",
          action: "VERIFY_OTP"
        }
      }
    ]
  ]
};





  
  // -------- PLUGIN DEFINITION --------
  
  // Main plugin export
const fusePlugin: Plugin = {
  name: "fuse-plugin",
  description: "Fuse Cooperative Management plugin for Eliza OS",
  
  // Set up both providers
  providers: [
    {
      get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
        const cooperativesList = Object.keys(COOPERATIVE_MAP).map(name => `- ${name}`).join('\n');
        
        return `
# Available Cooperatives
The following cooperatives are currently supported:
${cooperativesList}

# Cooperative Validation Function
You can validate and normalize cooperative names using the function validateCooperative(input).
If a user mentions a cooperative name like "Immigration" it will be normalized to the correct tenant ID.
        `;
      }
    },
    {
      get: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
        try {
          elizaLogger.debug('debug', `Getting auth status for provider in room ${message.roomId}`);
          
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
          
          let statusMessage = `# Authentication Status\n`;
          statusMessage += `Current status: ${authState.status}\n`;
          
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
        } catch (error) {
          elizaLogger.error('error', 'Error getting auth status for provider', error);
          return `Error retrieving authentication status: ${error.message}`;
        }
      }
    }
  ],
  
  // Set up both actions
  actions: [verifyOTPAction, authenticateAction, resetAction, loanInfoAction],
};


export default fusePlugin;