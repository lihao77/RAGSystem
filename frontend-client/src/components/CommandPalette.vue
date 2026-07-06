<template>
  <CommandDialog :open="visible" @update:open="(v) => { if (!v) close() }">
    <CommandInput class="border-border px-3" placeholder="输入命令或搜索…" />
    <CommandList>
      <CommandEmpty>无匹配命令</CommandEmpty>
      <CommandGroup>
        <CommandItem
          v-for="cmd in allCommands"
          :key="cmd.id"
          :value="cmd.title"
          @select="onSelect(cmd)"
        >
          <span>{{ cmd.title }}</span>
          <span v-if="cmd.subtitle" class="text-sm text-muted-foreground">{{ cmd.subtitle }}</span>
          <span v-if="cmd.section" class="ml-auto text-xs text-muted-foreground">{{ cmd.section }}</span>
        </CommandItem>
      </CommandGroup>
    </CommandList>
  </CommandDialog>
</template>

<script setup>
import { useCommandPalette } from '../composables/useCommandPalette.js';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from './ui/command';

const { visible, allCommands, close } = useCommandPalette();

function onSelect(cmd) {
  close();
  if (typeof cmd.action === 'function') cmd.action();
}
</script>
