import { describe, it, expect } from "vitest";
import { classifyEnvelope, classifyRcpt, parseReply } from "./classify.js";

describe("parseReply", () => {
  it("parses a single-line reply with an enhanced code", () => {
    const r = parseReply("550 5.1.1 The email account that you tried to reach does not exist\r\n");
    expect(r.code).toBe(550);
    expect(r.enhanced).toBe("5.1.1");
    expect(r.text).toContain("does not exist");
  });
  it("joins multi-line replies and reads the code from the first line", () => {
    const r = parseReply("250-mx.example.com\r\n250-SIZE 1000\r\n250 8BITMIME\r\n");
    expect(r.code).toBe(250);
    expect(r.enhanced).toBeNull();
    expect(r.text).toBe("mx.example.com SIZE 1000 8BITMIME");
  });
  it("reads the enhanced code only when it leads the text", () => {
    expect(parseReply("452 Too many recipients from 4.2.2.1\r\n").enhanced).toBeNull();
    expect(parseReply("250-mx\r\n250 2.1.5 OK\r\n").enhanced).toBeNull(); // first line carries no code
    expect(parseReply("550 5.1.1 User unknown\r\n").enhanced).toBe("5.1.1");
    expect(parseReply("550-5.1.1 The email account\r\n550 5.1.1 does not exist\r\n").enhanced).toBe("5.1.1");
  });

  it("tolerates garbage", () => {
    expect(parseReply("").code).toBe(0);
    expect(parseReply("xyz\r\n").code).toBe(0);
  });
});

describe("classifyRcpt — structured enhanced codes first", () => {
  it.each([
    ["250 2.1.5 OK", "accepted"],
    ["250 2.1.5 Recipient <x@y.z> OK", "accepted"],
    ["550 5.1.1 The email account that you tried to reach does not exist", "invalid"],
    ["550 5.1.1 <x@y.z>: Recipient address rejected: User unknown in virtual mailbox table", "invalid"],
    ["550 5.1.0 Address rejected", "invalid"],
    ["550 5.1.3 Bad recipient address syntax", "invalid"],
    ["550 5.1.6 Recipient no longer on server", "invalid"],
    ["550 5.2.1 The email account that you tried to reach is disabled", "disabled"],
    ["552 5.2.2 Mailbox full", "full_inbox"],
    ["452 4.2.2 The recipient's inbox is out of storage space", "full_inbox"],
    ["550 5.7.1 Service unavailable, Client host [1.2.3.4] blocked using Spamhaus", "blocked"],
    ["554 5.7.1 <mta.voipdir.net[]>: Client host rejected: Access denied", "blocked"],
    ["550 5.7.1 Email doesn't exist. Please forward it or send it to contact@magency.f", "invalid"],
    ["450 4.7.1 <x@y.z>: Recipient address rejected: Greylisted, see http://postgrey.schweikert.net", "greylisted"],
    ["451 4.7.1 Please try again later", "greylisted"],
    ["451 4.3.0 Temporary system problem", "temp_failure"],
    ["450 4.1.1 Recipient address rejected: unverified address: try again", "greylisted"],
  ])("%s → %s", (raw, kind) => {
    expect(classifyRcpt(parseReply(`${raw}\r\n`))).toBe(kind);
  });
});

describe("classifyRcpt — phrase fallback for prose-only servers", () => {
  it.each([
    ["550 User unknown", "invalid"],
    ["550 No such user here", "invalid"],
    ["550 Requested action not taken: mailbox unavailable", "invalid"],
    ["554 delivery error: This user doesn't have an account", "invalid"],
    ["550 RCPT (***@stigpods.com.cn) dosn't exist", "invalid"],
    ["550 Usuario desconocido", "invalid"],
    ["550 El buzón no existe", "invalid"],
    ["550 Insufficient system storage", "unknown_reply"], // server-side, not the mailbox (R3 W-2)
    ["550 Buzon lleno", "full_inbox"],
    ["550 This account has been discontinued", "disabled"],
    ["550 Cuenta suspendida", "disabled"],
    ["550 Your IP is blacklisted", "blocked"],
    ["554 Relaying denied", "blocked"],
    ["550 Cannot find your reverse hostname", "blocked"],
    ["450 The user you are trying to contact is receiving mail at a rate that prevents additional messages", "accepted"],
    ["451 Greylisted, please try again in 300 seconds", "greylisted"],
    ["451 Resources temporarily unavailable", "temp_failure"],
    ["421 Service not available", "temp_failure"],
    ["550 Some brand new wording nobody has seen", "unknown_reply"],
  ])("%s → %s", (raw, kind) => {
    expect(classifyRcpt(parseReply(`${raw}\r\n`))).toBe(kind);
  });

  it.each([
    "550 5.7.1 Rechazado: el registro PTR no existe para su IP",
    "550 5.7.1 Su servidor no existe en nuestra lista blanca",
    "554 5.7.1 Access denied - you must have an account on this system to relay",
    "550 5.7.1 Only authenticated users that have an account here may send",
    "550 5.7.1 Sender domain could not be found in DNS",
    "550 5.7.1 Your reverse DNS record could not be found",
    "550 5.7.1 Message rejected: sender address error, check your SPF",
    "550 5.1.1 Sender address rejected: Domain not found",
    "550 Sender address rejected: need fully-qualified address",
    "554 Your access to this mail system has been rejected due to the sending MTA's poor reputation",
  ])("sender/IP-side refusal is blocked, never invalid: %s", (raw) => {
    expect(classifyRcpt(parseReply(`${raw}\r\n`))).toBe("blocked");
  });

  it.each([
    "550 5.1.1 <x@clinica.mx>: Recipient address rejected: User unknown in relay recipient table",
    "550 5.4.1 Recipient address rejected: Access denied. AS(201806281)",
    "550 5.1.1 <x@clinica.mx>: Recipient address rejected: User unknown in local recipient table",
    "550 5.1.1 User unknown; rejecting",
  ])("R2 C-1: common mailbox rejections stay invalid despite 'relay'/'access denied' prose: %s", (raw) => {
    expect(classifyRcpt(parseReply(`${raw}\r\n`))).toBe("invalid");
  });

  it.each([
    ["554 delivery error: dd This user doesn't have a yahoo.com account (x@yahoo.com) [0] - mta4123.mail.gq1.yahoo.com", "invalid"],
    ["554 delivery error: dd This user doesn't have a aol.com account (x@aol.com) [0] - mta4321.mail.bf1.yahoo.com", "invalid"],
    ["550 5.1.2 Mailbox does not exist.", "invalid"], // Stalwart
    ["550 El usuario no tiene una cuenta en este servidor", "invalid"],
    ["452 4.3.1 Insufficient system storage", "temp_failure"], // server disk, not the mailbox (R3 W-2)
    ["452 4.3.1 Insufficient system resources", "temp_failure"],
    ["450 4.7.25 Client host rejected: cannot find your hostname, [187.77.25.101]", "blocked"], // R3 W-4
    ["450 4.7.1 <x@y.z>: Sender address rejected: Domain not found", "blocked"],
  ])("R3: %s → %s", (raw, kind) => {
    expect(classifyRcpt(parseReply(`${raw}\r\n`))).toBe(kind);
  });

  it.each([
    ["550 5.7.0 Rejected: your organisation does not have a policy permitting external mail", "blocked"], // R4 W-1 prefix trap
    ["550 The recipient does not have an account here", "invalid"],
    ["550 5.7.26 This mail has been blocked because the sender is unauthenticated. Gmail requires all senders to authenticate; the message does not have authentication information", "blocked"],
    ["452 Too many recipients from 4.2.2.1", "temp_failure"], // IP-shaped token is not an enhanced code
    ["550 Mailbox unavailable; relay host 5.2.1.9 refused", "invalid"],
    ["451 4.7.1 Please try again later; your message from noreply@thelodge.com is queued", "greylisted"], // "helo" inside a hostname
    ["451 4.3.0 Temporarily rejected, greylisting is active; mail from this client host will be accepted on retry", "greylisted"],
    ["450 4.7.1 <x@y.z>: Recipient address rejected: Greylisted, see http://postgrey.schweikert.net/help/y.z.html", "greylisted"],
    ["550 5.7.1 <mail>: Helo command rejected: need fully-qualified hostname", "blocked"],
    ["450 4.1.8 <postmaster@mail>: Sender address rejected: Domain not found", "blocked"],
  ])("R4: %s → %s", (raw, kind) => {
    expect(classifyRcpt(parseReply(`${raw}\r\n`))).toBe(kind);
  });

  it.each([
    ["550 5.7.0 Sender does not have a mailbox on this server", "blocked"], // R5 C-1: subject-anchored
    ["550 5.7.1 We do not have an account for this domain", "blocked"],
    ["550 5.7.1 The sender doesn't have a valid account", "blocked"],
    ["554 5.1.1 This user doesn't have a yahoo.com account (x@yahoo.com) [0] - mta", "invalid"],
    ["550 The recipient does not have an account here", "invalid"],
    ["550 El usuario no tiene cuenta en este dominio", "invalid"],
    ["550 Invalid User (#5.1.1)", "invalid"], // qmail trailing code (R5 W-5)
    ["550 User not found (#5.1.1)", "invalid"],
    ["550 Account has been suspended (#5.2.1)", "disabled"],
    ["554 #5.2.2 Over quota", "full_inbox"],
    ["552 The mailbox is full", "full_inbox"],
  ])("R5: %s → %s", (raw, kind) => {
    expect(classifyRcpt(parseReply(`${raw}\r\n`))).toBe(kind);
  });

  it.each([
    ["550 This account is blocked", "unknown_reply"],
    ["550 The recipient has banned mail from your domain", "unknown_reply"], // safe bucket, not a strike
    ["550 Recipient does not accept spam", "unknown_reply"],
  ])("mailbox-state prose with bare block words does not strike the breaker: %s → %s", (raw, kind) => {
    expect(classifyRcpt(parseReply(`${raw}\r\n`))).toBe(kind);
  });

  it("does not misread a blocked reply as invalid", () => {
    // Upstream regression test: 'address' inside 'access denied' must not match.
    expect(classifyRcpt(parseReply("554 5.7.1 <mta.voipdir.net[]>: Client host rejected: Access denied\r\n"))).toBe("blocked");
  });
});

describe("classifyEnvelope", () => {
  it("maps 4xx to greylisted/temp and 5xx to blocked", () => {
    expect(classifyEnvelope(parseReply("421 4.7.0 Try again later\r\n"))).toBe("greylisted");
    expect(classifyEnvelope(parseReply("450 4.7.25 Client host rejected: cannot find your hostname\r\n"))).toBe("blocked");
    expect(classifyEnvelope(parseReply("421 4.3.2 Too many connections\r\n"))).toBe("temp_failure");
    expect(classifyEnvelope(parseReply("554 5.7.1 Service unavailable; Client host blocked\r\n"))).toBe("blocked");
    expect(classifyEnvelope(parseReply("550 5.1.8 Sender address rejected: Domain not found\r\n"))).toBe("blocked");
  });
});
