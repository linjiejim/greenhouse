export default {
  title: '每月复盘',
  description: '汇总团队使用情况、需求与花费，生成月度复盘。',
  generate: '生成本月复盘',
  generating: '生成中…',
  done: '{month} 复盘已写进知识库',
  open: '打开 {month} 复盘',
  failed: '复盘生成失败',
  skipped: {
    over_budget: '{month} 复盘已生成，但没有建议：团队模型额度已用完',
    no_model: '{month} 复盘已生成，但没有建议：没有配置可用的模型',
    failed: '{month} 复盘已生成，但没有建议：调用模型失败',
  },
};
