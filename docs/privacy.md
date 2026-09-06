# Privacy and action rules

These are implementation requirements, not claims of achieved protection.

## Boundary

The extension filters information before its AI requests leave the device. Ordinary website traffic and an approved form submission have separate destinations; the extension does not control all browser traffic.

Assume the browser and extension installation are trusted. Treat webpage content and server-generated actions as untrusted. A compromised operating system is outside the prototype scope.

## Export rules

- Export only task-relevant, explicitly permitted fields. Do not serialize the entire DOM.
- Exclude passwords, OTPs, authentication tokens, and API keys from exported context.
- Filter user instructions, DOM labels/values, OCR text, URLs, page titles, history, and error messages.
- Treat private messages, financial details, and confidential documents as sensitive even without a person's name.
- Replace sensitive text with task-scoped references. Keep the reference mapping local, out of logs, and clear it after the task.
- Overwrite sensitive image pixels with opaque masks and export a newly encoded image. Account for zoom, scrolling, and display scale.
- Withhold regions that cannot be inspected. On an incomplete scan or processing failure, block the affected export.
- Route AI requests through one export check. A second scan adds protection but does not prove that all sensitive information was found.
- Keep raw screenshots and private values out of persistent storage, telemetry, and server logs. Retain only sanitized operational metadata by default.

## Action rules

- Start with user-invoked tab access and narrowly scoped website permissions.
- Page text cannot authorize actions or change these rules.
- Validate task, website, observation version, target, and arguments before each action.
- Resolve private values only into the approved field on the approved website.
- Require local user confirmation for submit, send, delete, purchase, payment, and upload. Show the action's destination and effect.
- Revalidate after confirmation if the page changed. Include a stop control and step/time limits.
- Verify the result before proceeding; uncertain results pause execution.

## Evidence

Use synthetic sensitive values in tests. Inspect actual outgoing requests and logs, including failure paths. Report missed information and blocked exports separately; zero leaks in a test set is not a universal guarantee.

References: [Presidio detection limitations](https://github.com/microsoft/presidio/blob/main/docs/faq.md), [OWASP agent security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html), [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab).
