import { create } from 'zustand'

/** 设置弹窗的分组：用户 / 通用设置 / 数据管理 */
export type SettingsSection = 'account' | 'general' | 'data'

/** 设置弹窗：侧边栏底部等入口打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })
