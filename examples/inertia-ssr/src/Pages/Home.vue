<template>
  <div>
    <h1>Hello from Inertia SSR</h1>
    <p>Rendered by worker PID {{ pid }} on {{ hostname }}</p>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  pid: number;
  hostname: string;
}>();
</script>
