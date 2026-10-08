let submissionCount = 0;
let delayedTimer;
const form = document.querySelector('#application');
form.addEventListener('submit', event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  document.querySelector('#submission-count').textContent = String(++submissionCount);
  document.querySelector('#result').textContent = 'Application submitted successfully. Synthetic receipt: DEMO-001.';
});
document.querySelector('#layout').addEventListener('click', () => document.querySelector('#columns').classList.toggle('reversed'));
document.querySelector('#disable').addEventListener('click', () => {
  const phone = document.querySelector('#phone'); phone.disabled = !phone.disabled;
});
document.querySelector('#delay').addEventListener('click', () => {
  clearTimeout(delayedTimer);
  delayedTimer = setTimeout(() => {
    const label = document.createElement('label'); label.textContent = 'College name';
    const input = document.createElement('input'); input.id = 'college'; input.name = 'college';
    label.append(input); document.querySelector('#delayed').replaceChildren(label);
  }, 2000);
});
document.querySelector('#reset').addEventListener('click', () => location.reload());
