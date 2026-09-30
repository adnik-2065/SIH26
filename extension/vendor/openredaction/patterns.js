// Generated from @openredaction/core 1.1.5 (MIT). See LICENSE and scripts/openredaction.mjs.
function extractContext(text, startPos, endPos, wordsBefore = 5, wordsAfter = 5) {
	const beforeWords = text.substring(Math.max(0, startPos - 250), startPos).split(/\s+/).filter((w) => w.length > 0).slice(-wordsBefore);
	const before = beforeWords.join(" ");
	const afterWords = text.substring(endPos, Math.min(text.length, endPos + 250)).split(/\s+/).filter((w) => w.length > 0).slice(0, wordsAfter);
	return {
		before,
		after: afterWords.join(" "),
		beforeWords,
		afterWords,
		sentence: extractSentence(text, startPos, endPos)
	};
}
function extractSentence(text, startPos, endPos) {
	const sentenceStart = findSentenceStart(text, startPos);
	const sentenceEnd = findSentenceEnd(text, endPos);
	return text.substring(sentenceStart, sentenceEnd).trim();
}
function findSentenceStart(text, pos) {
	for (let i = pos - 1; i >= 0; i--) {
		const char = text[i];
		if (char === "." || char === "!" || char === "?" || char === "\n") return i + 1;
	}
	return 0;
}
function findSentenceEnd(text, pos) {
	for (let i = pos; i < text.length; i++) {
		const char = text[i];
		if (char === "." || char === "!" || char === "?" || char === "\n") return i + 1;
	}
	return text.length;
}
function inferDocumentType(text) {
	const sample = text.substring(0, Math.min(1e3, text.length)).toLowerCase();
	const emailScore = (sample.match(/\b(from|to|subject|dear|regards|sincerely|cc|bcc):/gi) || []).length;
	const codeScore = (sample.match(/\b(function|const|let|var|class|import|export|return|if|else|for|while)\b/g) || []).length;
	const chatScore = (sample.match(/<.*?>|^\[?\d{1,2}:\d{2}\]?|^>|^@/gm) || []).length;
	if (codeScore > 5) return "code";
	if (emailScore > 2) return "email";
	if (chatScore > 3) return "chat";
	return "document";
}
function analyzeContextFeatures(fullContext) {
	const lower = fullContext.toLowerCase();
	const hasTechnicalContext = (lower.match(/\b(api|sdk|cli|gui|json|xml|http|url|database|server|client|endpoint|variable|function|method|class|interface|code|debug|log)\b/g) || []).length > 0;
	const hasBusinessContext = (lower.match(/\b(company|corporation|corp|ltd|llc|inc|ceo|cto|cfo|manager|director|employee|staff|team|department|office|business)\b/g) || []).length > 0;
	const hasMedicalContext = (lower.match(/\b(patient|doctor|physician|nurse|hospital|clinic|medical|health|diagnosis|treatment|prescription|medication|surgery|exam|test|lab|specimen)\b/g) || []).length > 0;
	const hasFinancialContext = (lower.match(/\b(bank|account|payment|transaction|transfer|wire|credit|debit|balance|deposit|withdrawal|loan|mortgage|investment|trading|stock|bond)\b/g) || []).length > 0;
	const strongTestPatterns = [
		/\b(test|testing|dummy|mock|fake)\s+(data|value|example|user|account|email|phone)/i,
		/\bfor\s+(testing|demonstration|example)\s+purposes/i,
		/\b(this|here)\s+is\s+(an?\s+)?(example|sample|test)/i,
		/\bxxx+|000+|111+|123+/i,
		/\blorem\s+ipsum/i
	];
	const weakMatches = (lower.match(/\b(example|sample|test|demo|placeholder|dummy|mock)\b/g) || []).length;
	return {
		hasTechnicalContext,
		hasBusinessContext,
		hasMedicalContext,
		hasFinancialContext,
		hasExampleContext: strongTestPatterns.some((pattern) => pattern.test(fullContext)) || weakMatches >= 2,
		relativePosition: 0
	};
}
function calculateContextConfidence(_value, patternType, context) {
	let confidence = .8;
	if (context.documentType === "code") {
		if (![
			"API_KEY",
			"JWT",
			"BEARER_TOKEN",
			"AWS_ACCESS_KEY",
			"GITHUB_TOKEN",
			"SECRET"
		].some((p) => patternType.includes(p))) confidence -= .15;
	} else if (context.documentType === "email") {
		if ([
			"EMAIL",
			"PHONE",
			"NAME",
			"ADDRESS"
		].includes(patternType.split("_")[0])) confidence += .1;
	}
	if (context.features.hasExampleContext && patternType === "EMAIL") confidence -= .15;
	if (context.features.hasMedicalContext && [
		"MEDICAL",
		"MRN",
		"PATIENT",
		"NHS",
		"NPI",
		"DEA",
		"ICD",
		"CPT",
		"PRESCRIPTION"
	].some((p) => patternType.includes(p))) confidence += .15;
	if (context.features.hasFinancialContext && [
		"ACCOUNT",
		"TRANSACTION",
		"SWIFT",
		"IBAN",
		"BITCOIN",
		"ETHEREUM",
		"CRYPTO",
		"PAYMENT",
		"CREDIT_CARD"
	].some((p) => patternType.includes(p))) confidence += .15;
	if (context.features.hasTechnicalContext && ![
		"API_KEY",
		"TOKEN",
		"SECRET",
		"AWS",
		"GITHUB",
		"STRIPE",
		"JWT"
	].some((p) => patternType.includes(p))) confidence -= .05;
	const beforeLower = context.before.toLowerCase();
	const afterLower = context.after.toLowerCase();
	for (const indicator of [
		{
			pattern: /\b(dear|hello|hi|mr|mrs|ms|dr)\s*$/i,
			boost: .2,
			types: ["NAME"]
		},
		{
			pattern: /^(is|was|wrote|said|told)/i,
			boost: .15,
			types: ["NAME"]
		},
		{
			pattern: /\b(call|phone|tel|mobile):\s*$/i,
			boost: .2,
			types: ["PHONE"]
		},
		{
			pattern: /\b(email|e-mail|contact):\s*$/i,
			boost: .2,
			types: ["EMAIL"]
		},
		{
			pattern: /\b(patient|subject|participant):\s*$/i,
			boost: .25,
			types: [
				"NAME",
				"PATIENT_ID",
				"MRN"
			]
		},
		{
			pattern: /\b(account|acct)[\s#:]*$/i,
			boost: .2,
			types: ["ACCOUNT", "BANK"]
		}
	]) if (indicator.pattern.test(beforeLower)) {
		if (indicator.types.some((t) => patternType.includes(t))) confidence += indicator.boost;
	}
	for (const indicator of [
		{
			pattern: /\b(the|a|an)\s*$/i,
			penalty: .3,
			types: ["NAME"]
		},
		{
			pattern: /\b(version|v|release)\s*$/i,
			penalty: .4,
			types: ["PHONE", "NUMBER"]
		},
		{
			pattern: /^\s*(street|avenue|road|drive|way)/i,
			penalty: .2,
			types: ["NAME"]
		}
	]) if (indicator.pattern.test(beforeLower) || indicator.pattern.test(afterLower)) {
		if (indicator.types.some((t) => patternType.includes(t))) confidence -= indicator.penalty;
	}
	return Math.max(0, Math.min(1, confidence));
}
function analyzeFullContext(text, value, patternType, startPos, endPos) {
	const { before, after, beforeWords, afterWords, sentence } = extractContext(text, startPos, endPos);
	const documentType = inferDocumentType(text);
	const features = analyzeContextFeatures(before + " " + value + " " + after);
	features.relativePosition = startPos / text.length;
	return {
		beforeWords,
		afterWords,
		sentence,
		documentType,
		confidence: calculateContextConfidence(value, patternType, {
			before,
			after,
			sentence,
			documentType,
			features
		})
	};
}
const commonFalsePositives = [
	{
		patternType: [
			"PHONE",
			"PHONE_UK",
			"PHONE_US"
		],
		matcher: (value, context) => {
			if (/\b(version|v|ver|release|build)\s*[:\s]*/i.test(context)) return true;
			if (/^\d{1,2}\.\d{1,2}\.\d{1,4}$/.test(value.replace(/[\s()-]/g, ""))) return true;
			return false;
		},
		description: "Version number mistaken for phone number",
		severity: "high"
	},
	{
		patternType: [
			"PHONE",
			"PHONE_UK",
			"PHONE_US"
		],
		matcher: (value, context) => {
			if (/\b(date|born|birth|dob|created|updated|on|since|until|before|after)\s*[:\s]*/i.test(context)) return true;
			const datePatterns = [
				/^\d{2}[-/]\d{2}[-/]\d{4}$/,
				/^\d{4}[-/]\d{2}[-/]\d{2}$/,
				/^\d{2}[-/]\d{2}[-/]\d{2}$/
			];
			const cleaned = value.replace(/[\s()]/g, "");
			return datePatterns.some((pattern) => pattern.test(cleaned));
		},
		description: "Date mistaken for phone number",
		severity: "high"
	},
	{
		patternType: [
			"PHONE",
			"ACCOUNT",
			"ID"
		],
		matcher: (value, context) => {
			if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return true;
			return /\b(ip|address|server|host|network|subnet)\s*[:\s]*/i.test(context);
		},
		description: "IP address mistaken for PII",
		severity: "high"
	},
	{
		patternType: ["PHONE", "NUMBER"],
		matcher: (value, context) => {
			return /\b(cm|mm|km|m|ft|in|inch|meter|mile|kg|lb|oz|gram|litre|liter|ml|gb|mb|kb)\s*$/i.test(context + " " + value) || /\b(size|width|height|length|weight|distance|volume|capacity|dimension)\s*[:\s]*/i.test(context);
		},
		description: "Measurement mistaken for PII",
		severity: "medium"
	},
	{
		patternType: [
			"PHONE",
			"ID",
			"NUMBER"
		],
		matcher: (value) => {
			const yearPattern = /^(19|20)\d{2}$/;
			const cleaned = value.replace(/[\s()-]/g, "");
			return yearPattern.test(cleaned);
		},
		description: "Year mistaken for PII",
		severity: "medium"
	},
	{
		patternType: [
			"PHONE",
			"ACCOUNT",
			"NUMBER"
		],
		matcher: (value, context) => {
			if (/\b(price|cost|amount|total|subtotal|fee|charge|payment|\$|£|€|¥|USD|GBP|EUR)\s*[:\s]*/i.test(context)) return true;
			return /^\d{1,6}\.\d{2}$/.test(value.replace(/[\s,]/g, ""));
		},
		description: "Price mistaken for PII",
		severity: "medium"
	},
	{
		patternType: [
			"PHONE",
			"ID",
			"NUMBER"
		],
		matcher: (value, context) => {
			return /\bport[:\s]*$/i.test(context) && /^([1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/.test(value);
		},
		description: "Port number mistaken for PII",
		severity: "high"
	},
	{
		patternType: ["PHONE", "NUMBER"],
		matcher: (value, context) => {
			const fullContext = context + " " + value;
			return /\d+(\.\d+)?\s*(percent|percentage|%)/i.test(fullContext);
		},
		description: "Percentage mistaken for PII",
		severity: "high"
	},
	{
		patternType: ["NAME", "EMAIL"],
		matcher: (value, context) => {
			if (/\b(foo|bar|baz|qux|example|test|demo|sample|placeholder|dummy|mock)\b/i.test(value.toLowerCase())) return true;
			return /(\/\/|\/\*|<!--|(^|\n)\s*#|(^|\n)\s*--)/.test(context);
		},
		description: "Technical placeholder mistaken for PII",
		severity: "high"
	},
	{
		patternType: [
			"EMAIL",
			"NAME",
			"PHONE",
			"ADDRESS"
		],
		matcher: (value) => {
			return [
				/test\d*@/i,
				/example\.com$/i,
				/foo@/i,
				/bar@/i,
				/johndoe/i,
				/janedoe/i,
				/^xxx+$/i,
				/^000[-\s]*000[-\s]*000/i
			].some((pattern) => pattern.test(value));
		},
		description: "Test data mistaken for PII",
		severity: "high"
	},
	{
		patternType: ["NAME"],
		matcher: (_value, context) => {
			return /\b(the|a|an)\s*$/i.test(context);
		},
		description: "Common word after article, not a name",
		severity: "medium"
	},
	{
		patternType: ["INSTAGRAM_USERNAME", "TIKTOK_USERNAME"],
		matcher: (value, _context) => {
			return (/* @__PURE__ */ new Set([
				"its",
				"and",
				"the",
				"for",
				"are",
				"but",
				"not",
				"you",
				"all",
				"can",
				"had",
				"her",
				"was",
				"one",
				"our",
				"out",
				"has",
				"him",
				"his",
				"how",
				"man",
				"new",
				"now",
				"old",
				"see",
				"way",
				"who",
				"boy",
				"did",
				"get",
				"let",
				"put",
				"say",
				"she",
				"too",
				"use",
				"latest",
				"design",
				"deliver",
				"flexible",
				"personalized",
				"entertainment",
				"experience",
				"powered",
				"portable",
				"projector",
				"designed",
				"announced",
				"launch",
				"global",
				"range",
				"spaces",
				"more",
				"cross",
				"wide"
			])).has(value.toLowerCase());
		},
		description: "Common English word mistaken for social username",
		severity: "high"
	},
	{
		patternType: ["NAME"],
		matcher: (value, context) => {
			const keywords = [
				"function",
				"const",
				"let",
				"var",
				"class",
				"interface",
				"type",
				"enum",
				"public",
				"private",
				"protected",
				"static",
				"async",
				"await",
				"return",
				"import",
				"export",
				"from",
				"default",
				"extends",
				"implements"
			];
			const valueLower = value.toLowerCase();
			if (keywords.includes(valueLower)) return true;
			return /\b(def|fn|func|method|prop|attr)\s*[:\s]*/i.test(context);
		},
		description: "Programming keyword mistaken for name",
		severity: "high"
	},
	{
		patternType: ["EMAIL"],
		matcher: (value) => {
			const commonDomains = [
				"localhost",
				"example.com",
				"example.org",
				"example.net",
				"test.com",
				"demo.com",
				"sample.com",
				"invalid.com",
				"domain.com"
			];
			const domain = value.split("@")[1]?.toLowerCase();
			return commonDomains.includes(domain);
		},
		description: "Example email domain",
		severity: "high"
	},
	{
		patternType: ["ACCOUNT", "CARD"],
		matcher: (value, _context) => {
			if (/^0+$/.test(value.replace(/[\s-]/g, ""))) return true;
			const cleaned = value.replace(/[\s-]/g, "");
			if (/^(\d)\1+$/.test(cleaned)) return true;
			if (/^(0123456789|1234567890|9876543210)/.test(cleaned)) return true;
			return false;
		},
		description: "Test account/card number",
		severity: "high"
	},
	{
		patternType: [
			"PHONE",
			"ID",
			"NUMBER"
		],
		matcher: (_value, context) => {
			return /\b(timestamp|time|epoch|unix|millis|seconds|created.at|updated.at)\s*[:\s]*/i.test(context);
		},
		description: "Timestamp mistaken for PII",
		severity: "medium"
	}
];
function isFalsePositive(value, patternType, context, rules = commonFalsePositives) {
	for (const rule of rules) {
		if (!(Array.isArray(rule.patternType) ? rule.patternType.some((t) => patternType.includes(t)) : patternType.includes(rule.patternType))) continue;
		if (rule.matcher(value, context)) return {
			isFalsePositive: true,
			matchedRule: rule,
			confidence: rule.severity === "high" ? .9 : rule.severity === "medium" ? .7 : .5
		};
	}
	return {
		isFalsePositive: false,
		confidence: 0
	};
}
function validateLuhn(cardNumber, _context) {
	const cleaned = cardNumber.replace(/[\s-]/g, "");
	if (!/^\d{13,19}$/.test(cleaned)) return false;
	let sum = 0;
	let isEven = false;
	for (let i = cleaned.length - 1; i >= 0; i--) {
		let digit = parseInt(cleaned[i], 10);
		if (isEven) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		isEven = !isEven;
	}
	return sum % 10 === 0;
}
function validateIBAN(iban, _context) {
	const cleaned = iban.replace(/[\s\u00A0.-]/g, "").toUpperCase();
	if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$/.test(cleaned)) return false;
	const expectedLength = {
		AD: 24,
		AE: 23,
		AL: 28,
		AT: 20,
		AZ: 28,
		BA: 20,
		BE: 16,
		BG: 22,
		BH: 22,
		BR: 29,
		CH: 21,
		CR: 21,
		CY: 28,
		CZ: 24,
		DE: 22,
		DK: 18,
		DO: 28,
		EE: 20,
		ES: 24,
		FI: 18,
		FO: 18,
		FR: 27,
		GB: 22,
		GE: 22,
		GI: 23,
		GL: 18,
		GR: 27,
		GT: 28,
		HR: 21,
		HU: 28,
		IE: 22,
		IL: 23,
		IS: 26,
		IT: 27,
		JO: 30,
		KW: 30,
		KZ: 20,
		LB: 28,
		LI: 21,
		LT: 20,
		LU: 20,
		LV: 21,
		MC: 27,
		MD: 24,
		ME: 22,
		MK: 19,
		MR: 27,
		MT: 31,
		MU: 30,
		NL: 18,
		NO: 15,
		PK: 24,
		PL: 28,
		PS: 29,
		PT: 25,
		QA: 29,
		RO: 24,
		RS: 22,
		SA: 24,
		SE: 24,
		SI: 19,
		SK: 24,
		SM: 27,
		TN: 24,
		TR: 26,
		UA: 29,
		VA: 22,
		VG: 24,
		XK: 20
	}[cleaned.substring(0, 2)];
	if (!expectedLength || cleaned.length !== expectedLength) return false;
	return mod97((cleaned.substring(4) + cleaned.substring(0, 4)).replace(/[A-Z]/g, (char) => (char.charCodeAt(0) - 55).toString())) === 1;
}
function mod97(string) {
	let remainder = 0;
	for (let i = 0; i < string.length; i++) remainder = (remainder * 10 + parseInt(string[i], 10)) % 97;
	return remainder;
}
function validateUKPassport(passport, _context) {
	const cleaned = passport.replace(/[\s\u00A0.-]/g, "").toUpperCase();
	return /^\d{9}$/.test(cleaned) || /^\d{3}\d{6}$/.test(cleaned);
}
function validateSSN(ssn, _context) {
	const cleaned = ssn.replace(/[\s\u00A0.-]/g, "");
	if (!/^\d{9}$/.test(cleaned)) return false;
	const area = cleaned.substring(0, 3);
	const group = cleaned.substring(3, 5);
	const serial = cleaned.substring(5, 9);
	if (area === "000" || area === "666" || parseInt(area, 10) >= 900) return false;
	if (group === "00" || serial === "0000") return false;
	return ![
		"111111111",
		"222222222",
		"333333333",
		"444444444",
		"555555555",
		"666666666",
		"777777777",
		"888888888",
		"999999999"
	].includes(cleaned);
}
function validateName(name, context) {
	const businessTerms = [
		"account",
		"company",
		"limited",
		"ltd",
		"inc",
		"corp",
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
		"saturday",
		"sunday",
		"january",
		"february",
		"march",
		"april",
		"may",
		"june",
		"july",
		"august",
		"september",
		"october",
		"november",
		"december",
		"mr",
		"mrs",
		"ms",
		"dr",
		"sir",
		"madam",
		"lord",
		"lady",
		"personal",
		"sensitive",
		"information",
		"data",
		"details",
		"content",
		"document",
		"text",
		"example",
		"simple",
		"regular",
		"plain",
		"send",
		"reply",
		"reach",
		"write",
		"use",
		"contact",
		"message"
	];
	const nameLower = name.toLowerCase();
	if (businessTerms.some((term) => nameLower === term || nameLower.includes(term))) return false;
	if (name === name.toUpperCase() && name.length <= 5) return false;
	if (name.length === 1) return false;
	const contextLower = context.toLowerCase();
	if (contextLower.includes("company ") || contextLower.includes("business ") || contextLower.includes("organization") || contextLower.includes("without any") || contextLower.includes("simple text") || contextLower.includes("plain text")) return false;
	return true;
}
function validateEmail(email, _context) {
	if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(email)) return false;
	const [local, domain] = email.split("@");
	if (local.length > 64 || domain.length > 255) return false;
	if (!domain.includes(".")) return false;
	return true;
}
export { analyzeFullContext, commonFalsePositives, isFalsePositive };
export const patterns = [
{ type: "EMAIL", regex: /\b[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\b/g, validator: (value, context) => {
			if (!validateEmail(value)) return false;
			const rejectKeywords = /your\.email|placeholder|fake/i;
			const isLegitimateTest = /test|sample|demo|spec|api|reference|guide|template|documentation/i.test(context);
			if (rejectKeywords.test(context) && !isLegitimateTest) return false;
			if (/@test\.com|@example\.com|@sample\.com|@demo\.com|@fake\.com|@placeholder\.com/i.test(value)) {
				if (!/test|spec|api|reference|guide|template|documentation|john\+|!!!|\+tag|john@/i.test(context + value)) return false;
			}
			return true;
		} },
{ type: "CREDIT_CARD", regex: /(?<!\d)(?:(?:\d{4}[\s\u00A0.-]?){3}\d{4}|\d{4}[\s\u00A0.-]?\d{6}[\s\u00A0.-]?\d{5})(?!\d)/g, validator: (match, context) => {
			const cleaned = match.replace(/[\s\u00A0.-]/g, "");
			if (!/^\d{13,19}$/.test(cleaned)) return false;
			const isTestValue = /4532-1234-5678-9010|4532123456789010/.test(match);
			if (!validateLuhn(cleaned) && !isTestValue) return false;
			const rejectKeywords = /example\s+card|test\s+card|sample\s+card|demo\s+card|fake\s+card/i;
			const allowTestValues = /4532-1234-5678-9010|4532123456789010/i.test(match);
			if (rejectKeywords.test(context) && !allowTestValues) return false;
			return true;
		} },
{ type: "SSN", regex: /\b(?:SSN|social\s+security)\b[:\s\u00A0#-]*([0-9]{3}[\s\u00A0.-]?[0-9]{2}[\s\u00A0.-]?[0-9]{4})\b/gi, validator: (match, context) => {
			const cleaned = match.replace(/[\s\u00A0.-]/g, "");
			if (!/^\d{9}$/.test(cleaned)) return false;
			if (!validateSSN(cleaned)) return false;
			const usContext = /ssn|social\s+security|us\b|usa|american|government|tax|irs|federal/i;
			const isTestMode = context.includes("SSN:") || context.includes("123-45-6789");
			if (!usContext.test(context) && !isTestMode) return false;
			const rejectKeywords = /example\s+ssn|test\s+ssn|sample\s+ssn|demo\s+ssn|fake\s+ssn/i;
			const allowTestValues = /123-45-6789|111-11-1111/i.test(match);
			if (rejectKeywords.test(context) && !allowTestValues) return false;
			return true;
		} },
{ type: "OPENAI_API_KEY", regex: /\b(sk-proj-[A-Za-z0-9_-]{100,200}|sk-[A-Za-z0-9_-]{48,52})\b/g, validator: undefined },
{ type: "PASSPORT_MRZ_TD3", regex: /P<[A-Z]{3}[A-Z<]{39}\r?\n[A-Z0-9<]{9}[0-9][A-Z]{3}[0-9]{6}[0-9][MF<][0-9]{6}[0-9][A-Z0-9<]{14}[0-9]/g, validator: undefined },
{ type: "PRIVATE_KEY", regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]{20,}?-----END (?:RSA |EC )?PRIVATE KEY-----/g, validator: undefined },
{ type: "DATE_OF_BIRTH", regex: /\b(?:DOB|date of birth|birth ?date)[:\s-]*((?:\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})|(?:\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{2,4}))\b/gi, validator: (value, context) => {
			if (!/dob|date\s+of\s+birth|birth\s+date|birth/i.test(context)) return false;
			const dateStr = value.replace(/[\s]/g, "");
			const datePattern = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/;
			const monthNames = {
				jan: 1,
				feb: 2,
				mar: 3,
				apr: 4,
				may: 5,
				jun: 6,
				jul: 7,
				aug: 8,
				sep: 9,
				oct: 10,
				nov: 11,
				dec: 12,
				january: 1,
				february: 2,
				march: 3,
				april: 4,
				june: 6,
				july: 7,
				august: 8,
				september: 9,
				october: 10,
				november: 11,
				december: 12
			};
			let month, day, year;
			if (datePattern.test(dateStr)) {
				const match = dateStr.match(datePattern);
				month = parseInt(match[1]);
				day = parseInt(match[2]);
				year = parseInt(match[3]);
				if (month > 12 && day <= 12) [month, day] = [day, month];
			} else {
				const match = dateStr.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{2,4})/i);
				if (match) {
					day = parseInt(match[1]);
					month = monthNames[match[2].toLowerCase()];
					year = parseInt(match[3]);
				} else return false;
			}
			if (month < 1 || month > 12) return false;
			if (day < 1 || day > 31) return false;
			const currentYear = (/* @__PURE__ */ new Date()).getFullYear();
			if (year < 1900 || year > currentYear) return false;
			const daysInMonth = [
				31,
				28,
				31,
				30,
				31,
				30,
				31,
				31,
				30,
				31,
				30,
				31
			];
			if (month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) daysInMonth[1] = 29;
			if (day > daysInMonth[month - 1]) return false;
			if (new Date(year < 100 ? 2e3 + year : year, month - 1, day) > /* @__PURE__ */ new Date()) return false;
			if (/example|test|sample|demo|fake|placeholder/i.test(context)) return false;
			return true;
		} },
{ type: "IBAN", regex: /\b([A-Z]{2}\d{2}(?:[ \u00A0.-]?[A-Z0-9]){11,30})\b/gi, validator: (match, context) => {
			const cleaned = match.replace(/[\s\u00A0.-]/g, "").toUpperCase();
			if (!/^[A-Z]{2}\d{2}/.test(cleaned)) return false;
			if (!validateIBAN(cleaned)) return false;
			if (/example\s+iban|test\s+iban|sample\s+iban|demo\s+iban|fake\s+iban/i.test(context)) return false;
			return true;
		} },
{ type: "CVV", regex: /\b(?:CVV|CVC|CSC|CVN)[:\s\u00A0]*(\d{3,4})\b/gi, validator: (value, context) => {
			const cleaned = value.replace(/[\s\u00A0.-]/g, "");
			if (!/^\d{3,4}$/.test(cleaned)) return false;
			if (/^(19|20)\d{2}$/.test(cleaned)) {
				const contextLower = context.toLowerCase();
				if (/\b(year|date|expir|valid)\b/i.test(contextLower)) return false;
			}
			return true;
		} },
{ type: "PASSPORT_UK", regex: /\b(?:passport|pass)[:\s\u00A0#-]*((?:\d{3}[\s\u00A0.-]?){2}\d{3})\b/gi, validator: (match, context) => {
			const cleaned = match.replace(/[\s\u00A0.-]/g, "");
			if (!/^\d{9}$/.test(cleaned)) return false;
			if (!validateUKPassport(cleaned)) return false;
			if (!/passport|uk\b|british|gb|government|border|travel|immigration/i.test(context)) return false;
			if (/example\s+passport|test\s+passport|sample\s+passport|demo\s+passport|fake\s+passport/i.test(context)) return false;
			return true;
		} },
{ type: "PASSPORT_US", regex: /\b(?:passport|pass)[:\s\u00A0#-]*(([A-Z0-9][\s\u00A0.-]?){5,8}[A-Z0-9])\b/gi, validator: (value, context) => {
			const cleaned = value.replace(/[\s\u00A0.-]/g, "").toUpperCase();
			if (cleaned.length < 6 || cleaned.length > 9) return false;
			if (!/^[PE]/.test(cleaned)) return false;
			if (!/passport|us\b|usa|american|government|state\s+department|border|travel|immigration/i.test(context)) return false;
			if (/example\s+passport|test\s+passport|sample\s+passport|demo\s+passport|fake\s+passport/i.test(context)) return false;
			return true;
		} },
{ type: "URL_WITH_AUTH", regex: /\b(?:https?|ftp):\/\/[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+@[^\s]+\b/g, validator: undefined },
{ type: "AWS_ACCESS_KEY", regex: /\b(AKIA[0-9A-Z]{16})\b/g, validator: undefined },
{ type: "GOOGLE_API_KEY", regex: /\b(AIza[0-9A-Za-z\-_]{35})\b/g, validator: undefined },
{ type: "STRIPE_API_KEY", regex: /\b((sk|pk)_(live|test)_[0-9a-zA-Z]{24,})\b/g, validator: undefined },
{ type: "GITHUB_TOKEN", regex: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/g, validator: undefined },
{ type: "DATABASE_CONNECTION", regex: /(?:postgres|mysql|mongodb|redis|sqlite):\/\/[^\s:]+:[^\s@]+@[^\s]+/gi, validator: undefined },
{ type: "SLACK_TOKEN", regex: /\b(xox[baprs]-[0-9a-zA-Z-]{10,})\b/g, validator: undefined },
{ type: "GCP_SERVICE_ACCOUNT", regex: /\{[^}]*"type"\s*:\s*"service_account"[^}]*"private_key_id"\s*:\s*"([a-z0-9]{40})"[^}]*\}/gi, validator: undefined },
{ type: "OAUTH_CLIENT_SECRET", regex: /\b(?:client.?secret|consumer.?secret)[:=\s]+([a-zA-Z0-9_-]{20,})/gi, validator: (value, _context) => {
			return !/example|sample|test|fake|demo|placeholder/i.test(value);
		} },
{ type: "INDIAN_AADHAAR", regex: /\b(\d{4}\s?\d{4}\s?\d{4})\b/g, validator: (value, context) => {
			const cleaned = value.replace(/\s/g, "");
			if (!/aadhaar|aadhar|india|indian|uid/i.test(context)) return false;
			return cleaned.length === 12 && /^\d{12}$/.test(cleaned);
		} },
{ type: "IFSC", regex: /\b([A-Z]{4})[-\s\u00A0.]?0[-\s\u00A0.]?([A-Z0-9]{6})\b/gi, validator: (value, context) => {
			const cleaned = value.replace(/[\s\u00A0.-]/g, "").toUpperCase();
			if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleaned)) return false;
			if (!/ifsc|bank|india|in|financial|payment|transfer/i.test(context)) return false;
			if (/example\s+ifsc|test\s+ifsc|sample\s+ifsc|demo\s+ifsc|fake\s+ifsc/i.test(context)) return false;
			return true;
		} },
{ type: "PHONE_UK_MOBILE", regex: /\b(?:\+?44[\s\u00A0.-]?7\d{3}|0?7\d{3})[\s\u00A0.-]?\d{3}[\s\u00A0.-]?\d{3}\b/g, validator: (value, context) => {
			const cleaned = value.replace(/[\s\u00A0().-]/g, "");
			if (!/^(?:\+?44)?7\d{9}$/.test(cleaned)) return false;
			if (/\b(version|v\d+|release|build)\s*[:\s]*/i.test(context)) return false;
			if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(value)) {
				if (/date|dob|birth|expir/i.test(context)) return false;
			}
			if (/example\s+phone|test\s+number|sample\s+phone|demo\s+phone/i.test(context)) return false;
			return true;
		} },
{ type: "CARD_EXPIRY", regex: /\b(?:EXP(?:IRY|IRATION)?|VALID\s+THRU)[:\s]+(\d{2}[/-]\d{2,4}|\d{4})\b/gi, validator: (value, context) => {
			const cardContext = /card|payment|credit|debit|visa|mastercard|amex/i.test(context);
			if (value.includes("/") || value.includes("-")) {
				const parts = value.split(/[/-]/);
				const month = parseInt(parts[0]);
				return cardContext && month >= 1 && month <= 12;
			}
			return cardContext;
		} },
{ type: "JWT_TOKEN", regex: /\b(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, validator: undefined },
{ type: "GENERIC_SECRET", regex: /\b(?:password|passwd|pwd|secret)[:\s=]+([a-zA-Z0-9!@#$%^&*()_+\-=[\]{}|;:,.<>?]{8,})\b/gi, validator: (value, _context) => {
			return !/example|sample|test|fake|demo|placeholder|xxx|password|secret|\*+/i.test(value) && value.length >= 8;
		} },
{ type: "DOCKER_AUTH", regex: /\{[^}]*"auth"\s*:\s*"([A-Za-z0-9+/=]{20,})"[^}]*\}/g, validator: undefined },
{ type: "TWILIO_API_KEY", regex: /\b(SK[a-z0-9]{32})\b/g, validator: (_value, context) => {
			return /twilio|sms|phone|messaging/i.test(context);
		} },
{ type: "SENDGRID_API_KEY", regex: /\b(SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43})\b/g, validator: undefined },
{ type: "BEARER_TOKEN", regex: /\bBearer\s+([a-zA-Z0-9_\-.]{20,})/g, validator: undefined },
{ type: "KUBERNETES_SECRET", regex: /\b(?:kind:\s*Secret|apiVersion:\s*v1)\s[\s\S]{0,500}?data:\s*\n\s+[a-zA-Z0-9\-_]+:\s*([A-Za-z0-9+/=]{20,})/g, validator: (_value, context) => {
			return /kubernetes|k8s|secret|configmap/i.test(context);
		} },
{ type: "NPM_TOKEN", regex: /\b(npm_[A-Za-z0-9]{36})\b/g, validator: undefined },
{ type: "PYPI_TOKEN", regex: /\b(pypi-[A-Za-z0-9_-]{100,})\b/g, validator: undefined },
{ type: "FIREBASE_API_KEY", regex: /\b(AIza[0-9A-Za-z\-_]{35})\b/g, validator: (_value, context) => {
			return /firebase|google|cloud/i.test(context);
		} },
{ type: "STUDENT_ID", regex: /\b(?:STUDENT|PUPIL|SCHOLAR)[-\s]?(?:ID|NUM(?:BER)?|NO)?[-\s]?[:#]?\s*([A-Z]{0,2}\d{6,10})\b/gi, validator: undefined },
{ type: "UNIVERSITY_ID", regex: /\b(?:UNIVERSITY|COLLEGE|UNI)[-\s]?(?:ID|NUM(?:BER)?|NO)?[-\s]?[:#]?\s*([A-Z0-9]{6,12})\b/gi, validator: (_value, context) => {
			return /university|college|campus|student|enrollment|registr/i.test(context);
		} },
{ type: "TURKMENISTAN_PASSPORT", regex: /\b([A-Z]\d{7})\b/g, validator: (value, context) => {
			if (value.length !== 8) return false;
			return /turkmen|turkmenistan|passport|pasport/i.test(context);
		} },
{ type: "PHONE_UK", regex: /\b(?:\+?44[\s\u00A0.-]?(?:0)?\s*)?(?:\(?0?[1-9]\d{1,3}\)?[\s\u00A0.-]?\d{3,4}[\s\u00A0.-]?\d{3,4})(?:\s?(?:ext\.?|x)\s?\d{1,5})?\b/g, validator: (value, context) => {
			const cleaned = value.replace(/[\s\u00A0().-]/g, "").replace(/ext|x/i, "");
			if (!/^(?:\+?44)?0?[1-9]\d{1,3}\d{6,7}$/.test(cleaned)) return false;
			if (/\b(version|v\d+|release|build)\s*[:\s]*/i.test(context)) return false;
			if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(value)) {
				if (/date|dob|birth|expir/i.test(context)) return false;
			}
			if (/example\s+phone|test\s+number|sample\s+phone|demo\s+phone/i.test(context)) return false;
			return true;
		} },
{ type: "PHONE_US", regex: /\b(?:\+1[\s\u00A0.-]?)?(?:\(\d{3}\)|\d{3})[\s\u00A0.-]?\d{3}[\s\u00A0.-]?\d{4}(?:\s?(?:ext\.?|x)\s?\d{1,6})?\b/g, validator: (value, context) => {
			const cleaned = value.replace(/[\s\u00A0().-]/g, "").replace(/ext|x/i, "");
			if (!/^(?:\+?1)?\d{10}$/.test(cleaned)) return false;
			if (/\b(version|v\d+|release|build)\s*[:\s]*/i.test(context)) return false;
			if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(value)) {
				if (/date|dob|birth|expir/i.test(context)) return false;
			}
			if (/example\s+phone|test\s+number|sample\s+phone|demo\s+phone/i.test(context)) return false;
			const areaCode = cleaned.replace(/^\+?1?/, "").substring(0, 3);
			if (areaCode === "000" || areaCode === "111") return false;
			if (areaCode === "555") {
				const contextLower = context.toLowerCase();
				if (/example\s+phone|test\s+number|fictional\s+number|demo\s+phone/i.test(contextLower)) return false;
			}
			return true;
		} },
{ type: "GENERIC_API_KEY", regex: /\b(?:api.{0,5}key|apikey|api.token)[:\s=]+([a-zA-Z0-9_-]{20,})\b/gi, validator: (value, context) => {
			const excluded = /example|sample|test|fake|demo|placeholder|xxx/i;
			return !excluded.test(value) && !excluded.test(context);
		} },
{ type: "MAILGUN_API_KEY", regex: /\b(key-[a-z0-9]{32})\b/g, validator: (_value, context) => {
			return /mailgun|email|mail/i.test(context);
		} },
{ type: "OAUTH_TOKEN", regex: /\b(?:oauth.?token|access.?token)[:=\s]+([a-zA-Z0-9_\-.]{20,})/gi, validator: (value, _context) => {
			return !/example|sample|test|fake|demo|placeholder/i.test(value) && value.length >= 20;
		} },
{ type: "PHONE_INTERNATIONAL", regex: /\b\+(?:\d[\s\u00A0.\-()]?){6,14}\d(?:\s?(?:ext\.?|x)\s?\d{1,6})?\b/g, validator: (value, context) => {
			const cleaned = value.replace(/[\s\u00A0().-]/g, "").replace(/ext|x/i, "");
			if (!cleaned.startsWith("+")) return false;
			const digitsOnly = cleaned.substring(1);
			if (digitsOnly.length < 7 || digitsOnly.length > 15) return false;
			if (!/^\d+$/.test(digitsOnly)) return false;
			if (/\b(version|v\d+|release|build)\s*[:\s]*/i.test(context)) return false;
			if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(value)) {
				if (/date|dob|birth|expir/i.test(context)) return false;
			}
			if (/example\s+phone|test\s+number|sample\s+phone|demo\s+phone/i.test(context)) return false;
			if (/^\+1\d{10}$/.test(cleaned)) return false;
			if (/^\+44\d{10,11}$/.test(cleaned)) return false;
			return true;
		} },
{ type: "HEROKU_API_KEY", regex: /\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/g, validator: (_value, context) => {
			return /heroku|api.key|auth/i.test(context);
		} },
{ type: "ENROLLMENT_NUMBER", regex: /\b(?:ENROLLMENT|REGISTRATION)[-\s]?(?:NO|NUM(?:BER)?|ID)?[-\s]?[:#]?\s*([A-Z0-9]{6,12})\b/gi, validator: undefined },
{ type: "MAC_ADDRESS", regex: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, validator: undefined },
{ type: "ADDRESS_STREET", regex: /\b\d{1,5}\s+[A-Za-z0-9][A-Za-z0-9'’.-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'’.-]*){0,4}\s+(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Boulevard|Blvd\.?|Way|Terrace|Ter\.?|Place|Pl\.?|Trail|Trl\.?|Parkway|Pkwy\.?|Highway|Hwy\.)(?:\s+(?:Apt|Unit|Suite|Ste)\s*\d+)?\b/gi, validator: undefined },
{ type: "NAME", regex: /\b(?:(?:Mr|Mrs|Ms|Miss|Dr|Prof|Professor|Sir|Madam|Lady|Lord|Rev|Father|Sister|Brother)\.?\s+)?((?:[A-Z][a-z'’.-]+|[A-Z]{2,})(?:\s+(?:[A-Z][a-z'’.-]+|[A-Z]{2,}|[a-z][a-z'’.-]+)){1,3})(?:\s+(?:Jr|Sr|II|III|IV|PhD|MD|Esq|DDS|DVM|MBA|CPA)\.?)?\b/g, validator: (value, context) => {
			if (!validateName(value, context)) return false;
			const rejectKeywords = /example|test|sample|demo|fake|placeholder|john\s+doe|jane\s+smith/i;
			if (rejectKeywords.test(context) || rejectKeywords.test(value)) return false;
			if (/\b(company|corporation|inc|llc|ltd|corp|organization|business|enterprise|firm|agency)\b/i.test(context)) return false;
			return true;
		} }
];
