/** Reveal a control through the same native disclosures used by a person. */
async function reveal(page, selector) {
  const target = typeof selector === 'string' ? page.locator(selector) : selector;
  await target.first().waitFor({state: 'attached'});
  const ancestors = await target.first().locator('xpath=ancestor::details').all();
  const ordered = await Promise.all(ancestors.map(async locator => ({locator, depth: await locator.evaluate(element => {
    let depth = 0;for (let parent = element.parentElement; parent; parent = parent.parentElement) depth++;
    return depth;
  })})));
  ordered.sort((left, right) => left.depth - right.depth);
  for (const {locator} of ordered) {
    if (!(await locator.evaluate(element => element.open))) await locator.locator(':scope > summary').click();
  }
  return target;
}

module.exports = {reveal};
