<script setup>
import FileManagerPanel from '@/components/layout/FileManagerPanel.vue'

/**
 * 左侧文件栏容器。
 *
 * 大纲已独立成右侧的 OutlinePanel，这里只承载文件树；
 * 保留独立组件是为了让 HomeView 的左右两栏职责清晰、便于各自扩展。
 */
</script>

<template>
  <div
    class="sidebar-panel h-full min-w-0 flex flex-col overflow-hidden bg-bg-primary text-text-primary"
    data-testid="sidebar-panel"
  >
    <div class="sidebar-panel__content relative min-h-0 flex-1 overflow-hidden">
      <FileManagerPanel />
    </div>
  </div>
</template>
