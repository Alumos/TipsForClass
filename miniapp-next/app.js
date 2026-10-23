App({
  onLaunch() { require('./utils/session').pruneDrafts(); },
  globalData: { copyMessage: null }
});
