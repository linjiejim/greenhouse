/** 中文文案 — 结构与 en.ts 完全一致（见 ./setup.ts 注册）。 */
export const zh = {
  common: {
    save: '保存',
    cancel: '取消',
    settings: '设置',
  },

  options: {
    title: 'Greenhouse 伴侣',
    subtitle: '连接你自部署的 Greenhouse 实例。',

    connection: '连接',
    baseUrl: '服务器地址',
    baseUrlPlaceholder: 'https://greenhouse.example.com',
    baseUrlInvalid: '请输入有效的地址，例如 https://greenhouse.example.com',
    connect: '连接',
    connecting: '连接中…',
    serverUnreachable: '无法在该地址访问到 Greenhouse API。',
    permissionDenied: '主机权限被拒绝——没有该权限扩展无法调用这台服务器。',
    authDisabledHint: '该实例未开启认证（开发模式）。暂不支持免登录使用——请在服务器上配置 ACCESS_PASSWORD。',

    signIn: '登录',
    email: '邮箱',
    password: '密码',
    passwordHint: '密码只会发送到上面的服务器，扩展不会存储密码。',
    signInAction: '登录',
    signingIn: '登录中…',
    loginFailed: '登录失败，请检查邮箱和密码。',
    networkError: '网络错误——请检查服务器地址和网络连接。',

    connectedTo: '已连接到',
    signedInAs: '当前用户',
    signOut: '退出登录',

    preferences: '偏好设置',
    language: '语言',
    theme: '主题',
    themeLight: '浅色',
    themeDark: '深色',
    themeSystem: '跟随系统',
  },

  panel: {
    notConnectedTitle: '尚未连接',
    notConnectedHint: '先把扩展连接到你的 Greenhouse 实例，就可以带着页面上下文提问了。',
    openSettings: '打开设置',
    connected: '已连接',
    chatComingSoon: '带页面上下文的对话将在下一个里程碑上线——连接已就绪。',
  },
};
