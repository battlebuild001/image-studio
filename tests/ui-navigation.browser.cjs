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

/** Delivery tools live outside the per-project settings dialog. */
async function closeStudioWorkbench(page) {
  if (await page.locator('#videoUploadDialog').isVisible()) {
    await page.locator('#closeVideoUploadBtn').click();
    await page.locator('#videoUploadDialog').waitFor({state:'hidden'});
  } else if (await page.locator('#productionWorkbenchDialog').isVisible()) {
    await page.locator('#closeProductionWorkbenchBtn').click();
    await page.locator('#productionWorkbenchDialog').waitFor({state:'hidden'});
  }
}
async function openProductionSection(page, section) {
  const delivery=['shorts','publishing','youtube','series'].includes(section);
  const target=delivery?'#videoUploadDialog':'#productionWorkbenchDialog';
  const other=delivery?'#productionWorkbenchDialog':'#videoUploadDialog';
  if (await page.locator(other).isVisible()) await closeStudioWorkbench(page);
  if (!await page.locator(target).isVisible()) await page.locator(delivery?'#videoUploadBtn':'#productionToolsBtn').click();
  await page.locator((delivery?'#uploadTab-':'#productionTab-')+section).click();
}
module.exports.openProductionSection=openProductionSection;
module.exports.closeStudioWorkbench=closeStudioWorkbench;
