// Generated from @openredaction/core 1.1.5 (MIT). See LICENSE and scripts/openredaction.mjs.
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
export const patterns = [
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
{ type: "IBAN", regex: /\b([A-Z]{2}\d{2}(?:[ \u00A0.-]?[A-Z0-9]){11,30})\b/gi, validator: (match, context) => {
			const cleaned = match.replace(/[\s\u00A0.-]/g, "").toUpperCase();
			if (!/^[A-Z]{2}\d{2}/.test(cleaned)) return false;
			if (!validateIBAN(cleaned)) return false;
			if (/example\s+iban|test\s+iban|sample\s+iban|demo\s+iban|fake\s+iban/i.test(context)) return false;
			return true;
		} },
{ type: "GOOGLE_API_KEY", regex: /\b(AIza[0-9A-Za-z\-_]{35})\b/g, validator: undefined },
{ type: "DATABASE_CONNECTION", regex: /(?:postgres|mysql|mongodb|redis|sqlite):\/\/[^\s:]+:[^\s@]+@[^\s]+/gi, validator: undefined },
{ type: "SLACK_TOKEN", regex: /\b(xox[baprs]-[0-9a-zA-Z-]{10,})\b/g, validator: undefined },
{ type: "MAC_ADDRESS", regex: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, validator: undefined }
];
