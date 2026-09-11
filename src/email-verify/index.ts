export { EmailVerifier, getSharedVerifier, verifierOptionsFromEnv, deriveMailDomain } from "./verify.js";
export type { VerifyResult, VerifyOptions, VerifierOptions, Verdict, BatchSummary, SmtpDetails } from "./verify.js";
export { checkSyntax, suggestDomain } from "./syntax.js";
export { lookupMx } from "./mx.js";
export { classifyRcpt, classifyEnvelope, parseReply } from "./classify.js";
export { probeMailbox, ProbeError } from "./smtp-client.js";
export { Governor, DEFAULT_GOVERNANCE } from "./governance.js";
