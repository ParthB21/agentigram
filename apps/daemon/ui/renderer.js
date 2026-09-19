const inspector = document.querySelector('#inspector');
const inspectButton = document.querySelector('#inspect-button');
const closeInspector = document.querySelector('#close-inspector');

inspectButton?.addEventListener('click', () => inspector?.classList.add('is-open'));
closeInspector?.addEventListener('click', () => inspector?.classList.remove('is-open'));

for (const button of document.querySelectorAll('.segmented button')) {
  button.addEventListener('click', () => {
    for (const peer of document.querySelectorAll('.segmented button'))
      peer.classList.remove('is-active');
    button.classList.add('is-active');
  });
}
