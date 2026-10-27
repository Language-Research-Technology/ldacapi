// Narrows the crate tree to crates whose name matches the filter, keeping their ancestors
const filter = document.getElementById('crate-filter');
const tree = document.getElementById('crates');

const narrow = (item, words) => {
  const children = item.querySelector(':scope > ul');
  const childMatches = children ? [...children.children].map((child) => narrow(child, words)).includes(true) : false;
  const name = item.dataset.name.toLowerCase();
  const matches = childMatches || words.every((word) => name.includes(word));
  item.hidden = !matches;
  return matches;
};

if (filter && tree) {
  filter.addEventListener('input', () => {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const item of tree.querySelectorAll(':scope > ul > li')) {
      narrow(item, words);
    }
  });
}
