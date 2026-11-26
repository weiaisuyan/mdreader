<script setup>
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import logo from '@/assets/img/logo.png'
import OtherLayout from '@/components/layout/OtherLayout.vue'
import TopBarActionButton from '@/components/layout/TopBarActionButton.vue'
import { useCommonStore } from '@/stores/counter.js'
import channelUtil from '@/util/channel/channelUtil.js'
import { notifyFirstScreenReady } from '@/util/startupLoadingUtil.js'

const { t } = useI18n()

const appInfo = ref({})

watch(() => useCommonStore().config.language, () => {
  window.document.title = t('aboutView.title')
}, { immediate: true })

onMounted(async () => {
  notifyFirstScreenReady()
  document.documentElement.style.fontSize = '16px'
  appInfo.value = await channelUtil.send({ event: 'get-app-info' })
})

function aboutMinimize() {
  channelUtil.send({ event: 'about-minimize' })
}
function aboutClose() {
  channelUtil.send({ event: 'about-close' })
}
</script>

<template>
  <OtherLayout icon="i-tabler:info-circle" :name="$t('aboutView.title')">
    <template #action>
      <TopBarActionButton icon="i-tabler:minus" @click="aboutMinimize" />
      <TopBarActionButton icon="i-tabler:x" danger @click="aboutClose" />
    </template>
    <div class="h-full w-full flex flex-col justify-between p-2">
      <div class="w-full text-center">
        <img :src="logo" alt="logo" class="w-30">
      </div>
      <div class="flex items-center justify-center gap-2 font-bold">
        <span>{{ appInfo.name }}</span>
        <span>v{{ appInfo.version }}</span>
      </div>
      <a-alert type="warning" show-icon :message="$t('aboutView.tip')" />
      <div class="flex items-center justify-center gap-2">
        <a-button
          type="link"
          href="https://github.com/weiaisuyan/mdreader"
          target="_blank"
        >
          GitHub
        </a-button>
        <a-divider type="vertical" />
        <a-button
          type="link"
          href="https://github.com/weiaisuyan/mdreader/releases"
          target="_blank"
        >
          {{ $t('aboutView.downloadPath') }}
        </a-button>
        <a-divider type="vertical" />
        <a-button
          type="link"
          href="https://github.com/weiaisuyan/mdreader/issues"
          target="_blank"
        >
          {{ $t('aboutView.issues') }}
        </a-button>
        <a-divider type="vertical" />
        <a-button
          type="link"
          href="https://github.com/weiaisuyan/mdreader/releases"
          target="_blank"
        >
          {{ $t('aboutView.updateLog') }}
        </a-button>
      </div>
    </div>
  </OtherLayout>
</template>

<style scoped lang="scss">
:deep(.ant-btn) {
  height: revert;
  padding: 0;
}
:deep(.ant-descriptions-item-label) {
  width: 90px;
}
</style>
