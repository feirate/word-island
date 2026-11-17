// App-based suites select a real local user through the same gate as a child.
// The dedicated browser-profiles suite covers creation/deletion/selection itself.
async function chooseTestProfile(page,name='测试') {
  await page.waitForFunction(()=>window.__wordIsland||document.querySelector('#profile-dialog[open]'),{timeout:30000});
  const dialog=page.locator('#profile-dialog');
  if(!await dialog.count()||!await dialog.evaluate(element=>element.open))return;
  const choice=dialog.locator('[data-profile-select]').first();
  if(await choice.count())await choice.click();
  else {
    await dialog.locator('#profile-name').fill(name);
    await dialog.locator('#create-profile').click();
  }
  await dialog.waitFor({state:'hidden',timeout:30000});
  await page.waitForFunction(()=>Boolean(window.__wordIsland?.getState().activeProfile),{timeout:30000});
}

module.exports={chooseTestProfile};
