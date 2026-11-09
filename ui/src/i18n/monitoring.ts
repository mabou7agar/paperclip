export const monitoringMessages = {
  en: {
    title: "Task needs attention",
    open: "Open task",
    missing_disposition: "Work ended without a recorded completion or waiting path. No agent was restarted.",
    dependency_ready: "Task dependencies are ready, but work has no live continuation. No agent was restarted.",
    no_execution_path: "This task has no live execution path. Monitoring will wait for a real change or your action.",
    monitor_due: "A task check is due. Monitoring reported it without starting an agent.",
    stopped_subtree: "Work in this task tree has stopped. Monitoring reported it without assigning recovery work.",
  },
  ar: {
    title: "مهمة تحتاج إلى انتباه",
    open: "فتح المهمة",
    missing_disposition: "انتهى العمل دون تسجيل الإكمال أو مسار انتظار. لم تتم إعادة تشغيل أي وكيل.",
    dependency_ready: "اكتملت اعتماديات المهمة، لكن لا يوجد تنفيذ نشط. لم تتم إعادة تشغيل أي وكيل.",
    no_execution_path: "لا يوجد مسار تنفيذ نشط لهذه المهمة. ستنتظر المراقبة تغييراً فعلياً أو إجراءً منك.",
    monitor_due: "حان موعد فحص المهمة. تم الإبلاغ عنه دون تشغيل وكيل.",
    stopped_subtree: "توقف العمل في شجرة المهام. تم الإبلاغ عنه دون إسناد عمل استعادة.",
  },
};
