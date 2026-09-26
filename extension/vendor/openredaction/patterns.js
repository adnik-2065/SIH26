// Generated from @openredaction/core 1.1.5 (MIT). See LICENSE and scripts/openredaction.mjs.
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
