export default {
  actions: {
    endSharedEdit() {
      this.appEvents.trigger("composer:close");
    },
  },
};
