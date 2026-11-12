/**
 * Extended Internationalization framework for Task Manager.
 * This file maps all UI-facing strings to translation keys.
 * 
 * TRANSLATION CONTRIBUTION GUIDE:
 * 1. To add a new translation key:
 *    - Add the key to the TranslationKey union type below
 *    - Add the English translation to the EN catalogue
 *    - Add translations to other language catalogues as they become available
 * 
 * 2. Key naming conventions:
 *    - Use dot notation for hierarchy: "section.subsection.key"
 *    - Use English names for keys, not translations
 *    - Examples: "modal.field.title", "action.complete", "settings.label.language"
 * 
 * 3. Translation guidelines:
 *    - Keep translations concise
 *    - Maintain consistency across the plugin
 *    - Use {{variable}} syntax for placeholders
 *    - Test RTL languages (Arabic, Hebrew, Farsi) if applicable
 * 
 * 4. Community contributions:
 *    - Include all keys in your language if possible
 *    - Include your name/username in the credits section at the end of your translation
 */

export type Locale = 'en' | 'zh' | 'de' | 'ko' | 'vi' | 'ru' | 'uk' | 'be' | 'pt-BR' | 'es';

export type TranslationKey =
  // Core UI - Sidebar and Panels
  | 'ui.panel.tasks'
  | 'ui.tab.today'
  | 'ui.tab.upcoming'
  | 'ui.tab.all'
  | 'ui.tab.agenda'
  | 'ui.tab.thisFile'
  | 'ui.tab.habits'
  | 'ui.loading'
  | 'ui.retry'
  | 'ui.sidebarLoadError'
  | 'ui.noFileActive'
  | 'ui.noMatchingTasks'
  | 'ui.noTasksForToday'
  | 'ui.taskCountSingular'
  | 'ui.taskCountPlural'
  | 'ui.clearSearch'
  | 'ui.clearGlyph'
  | 'ui.refreshTasks'
  | 'ui.skipToResults'
  | 'ui.viewMode'
  | 'ui.view.list'
  | 'ui.view.kanban'
  | 'ui.view.calendar'
  | 'ui.taskFilters'
  | 'ui.resultPages'
  | 'ui.searchLabel'
  | 'ui.searchPlaceholder'
  | 'ui.selectAllQueryResults'
  | 'ui.swipeComplete'
  | 'ui.swipeDefer'
  | 'ui.swipeCompleted'
  | 'ui.undo'
  | 'ui.deferFailed'
  | 'planning.undoLastScheduleChange'
  | 'planning.undidScheduleChange'
  | 'task.action.markComplete'
  | 'task.action.markIncomplete'
  | 'task.action.open'
  | 'task.action.openSource'
  | 'task.action.defer'
  | 'task.action.edit'
  | 'table.addTagTitle'
  | 'table.removeTagTitle'
  | 'table.selectedCount'
  | 'table.tagToAdd'
  | 'table.tagToRemove'
  | 'table.add'
  | 'table.remove'
  | 'table.noTagSuggestions'
  | 'table.suggestions'
  | 'table.cancel'
  | 'table.customFieldTitle'
  | 'table.customFieldDescription'
  | 'table.customFieldName'
  | 'table.customFieldValue'
  | 'table.apply'
  | 'table.fieldNameRequired'
  | 'table.addValue'
  | 'table.noValuesSelected'
  | 'table.removeValue'
  | 'table.save'
  | 'table.noMatchingTasks'
  | 'table.bulkPending'
  | 'table.bulkSuccess'
  | 'table.bulkPartial'
  | 'table.bulkFailed'
  | 'advancedFind.title'
  | 'advancedFind.resultsLabel'
  | 'advancedFind.text'
  | 'advancedFind.textPlaceholder'
  | 'advancedFind.priority'
  | 'advancedFind.dueFrom'
  | 'advancedFind.dueTo'
  | 'advancedFind.tag'
  | 'advancedFind.tagPlaceholder'
  | 'advancedFind.folder'
  | 'advancedFind.folderPlaceholder'
  | 'advancedFind.status'
  | 'advancedFind.any'
  | 'advancedFind.countSingular'
  | 'advancedFind.countPlural'
  | 'advancedFind.moreResults'
  | 'advancedFind.cannotOpen'
  | 'weeklyReview.title'
  | 'weeklyReview.progress'
  | 'weeklyReview.overdue.title'
  | 'weeklyReview.overdue.description'
  | 'weeklyReview.inbox.title'
  | 'weeklyReview.inbox.description'
  | 'weeklyReview.undated.title'
  | 'weeklyReview.undated.description'
  | 'weeklyReview.complete.title'
  | 'weeklyReview.complete.summary'
  | 'weeklyReview.complete.stats'
  | 'weeklyReview.openTask'
  | 'weeklyReview.moreTasks'
  | 'weeklyReview.next'
  | 'weeklyReview.finish'
  | 'onboarding.title'
  | 'onboarding.progress'
  | 'onboarding.firstTask.title'
  | 'onboarding.firstTask.description'
  | 'onboarding.firstTask.action'
  | 'onboarding.sidebar.title'
  | 'onboarding.sidebar.description'
  | 'onboarding.sidebar.action'
  | 'onboarding.query.title'
  | 'onboarding.query.description'
  | 'onboarding.query.action'
  | 'onboarding.remindLater'
  | 'onboarding.doNotShowAgain'
  | 'onboarding.finish'
  | 'onboarding.status.task'
  | 'onboarding.status.panel'
  | 'onboarding.status.inserted'
  | 'onboarding.status.copied'
  | 'onboarding.status.copyFailed'
  | 'onboarding.command.open'
  | 'settings.appleReminders.shortcutName'
  | 'settings.appleReminders.shortcutDescription'
  | 'settings.appleReminders.shortcutPlaceholder'
  | 'queryBuilder.title'
  | 'queryBuilder.filters'
  | 'queryBuilder.addFilter'
  | 'queryBuilder.sort'
  | 'queryBuilder.addSort'
  | 'queryBuilder.group'
  | 'queryBuilder.addGroup'
  | 'queryBuilder.viewMode'
  | 'queryBuilder.view'
  | 'queryBuilder.layout'
  | 'queryBuilder.limit'
  | 'queryBuilder.maxResults'
  | 'queryBuilder.limitPlaceholder'
  | 'queryBuilder.preview'
  | 'queryBuilder.insert'
  | 'queryBuilder.removeFilter'
  | 'queryBuilder.removeSort'
  | 'queryBuilder.removeGroup'
  | 'queryBuilder.status.updated'
  | 'queryBuilder.status.added'
  | 'queryBuilder.status.removed'
  | 'ui.agenda.dateHeading'
  | 'ui.agenda.noTasks'
  | 'ui.agenda.morning'
  | 'ui.agenda.afternoon'
  | 'ui.agenda.evening'
  | 'ui.agenda.noTime'
  | 'dashboard.title'
  | 'dashboard.scope.today'
  | 'dashboard.scope.week'
  | 'dashboard.scope.month'
  | 'dashboard.rangeLabel'
  | 'dashboard.action.refresh'
  | 'dashboard.action.edit'
  | 'dashboard.action.done'
  | 'dashboard.a11y.deadlineStrip'
  | 'dashboard.a11y.completionHeatmap'
  | 'dashboard.a11y.goalStreak'
  | 'planningBoard.action.advanceStatus'
  | 'kanban.moveTo'
  | 'gantt.reschedule'
  | 'timeline.reschedule'
  | 'notice.enableGoogleCalendar'
  | 'notice.enableAiTaskSearch'
  | 'notice.enableWeeklyReview'
  | 'notice.enableAppleReminders'
  | 'notice.enableCalDav'
  | 'dashboard.delete.confirmTitle'
  | 'dashboard.delete.confirmAction'
  | 'dashboard.delete.deleting'
  | 'dashboard.delete.undo'
  | 'dashboard.delete.retryRecovery'
  | 'dashboard.delete.recoveryCompleted'
  | 'dashboard.delete.recoveryRetained'
  | 'diagnostics.functionExpressions'
  | 'diagnostics.buildIdentity'
  | 'diagnostics.sourceDigest'
  | 'diagnostics.syncRunsFilter'
  | 'diagnostics.syncRunsLabel'
  | 'habits.loading'
  | 'habits.none'
  | 'habits.retry'
  | 'notice.applePayloadTooLarge'
  | 'settings.integration.obsidianBasesIntegration'
  | 'settings.integration.exposesTaskDataToObsidianBasesQueriesRequiresObsidianWith'
  | 'settings.integration.enableObsidianBasesIntegration'
  | 'settings.integration.regenerateTheTaskManagerBasesIndexAfterTaskCacheUpdates'
  | 'settings.integration.autoRefreshBasesExport'
  | 'settings.integration.millisecondsToWaitBeforeRefreshingGeneratedBasesFilesAfterCache'
  | 'settings.integration.basesRefreshDebounce'
  | 'settings.integration.500'
  | 'settings.integration.registerTaskDataWithDatacoreTheNextGenerationDataviewReplacement'
  | 'settings.integration.enableDatacoreIntegration'
  | 'settings.integration.queryBehaviour'
  | 'settings.integration.whenFilteringByDateEGDueBeforeUndatedSubtasks'
  | 'settings.integration.inheritParentDatesToSubtasks'
  | 'settings.integration.whenShowTreeIsActiveOnlyShowChildTasksThat'
  | 'settings.integration.filterSubtasksInTreeView'
  | 'settings.integration.whenEnabledPlainLanguageQueryTextLikeOverdueHighPriority'
  | 'settings.integration.enableNlpQueryFallback'
  | 'settings.integration.whenEnabledDraggingAKanbanCardBetweenStatusColumnsMay'
  | 'settings.integration.enableKanbanFileWriteback'
  | 'settings.integration.exportImport'
  | 'settings.integration.filePathForTheExportTasksToJsonCommandOutput'
  | 'settings.integration.jsonExportPath'
  | 'settings.integration.tasksExportJson'
  | 'settings.integration.filePathForTheExportTasksToYamlCommandOutput'
  | 'settings.integration.yamlExportPath'
  | 'settings.integration.tasksExportYaml'
  | 'settings.integration.arbitraryRemoteIcsFetchingIsDisabledBecauseObsidianRequesturlCannot'
  | 'settings.integration.remoteIcsImportUrlDisabled'
  | 'settings.integration.httpsCalendarExampleComBasicIcs'
  | 'settings.integration.noteWhereImportedCalendarEventsWillBeWrittenAsTasks'
  | 'settings.integration.icsImportTargetNote'
  | 'settings.integration.calendarImportMd'
  | 'settings.integration.vaultPathWhereThePublishedIcsCalendarFeedIsWritten'
  | 'settings.integration.icsFeedExportPath'
  | 'settings.integration.taskFeedIcs'
  | 'settings.googleTasks.openCalendarQuickAdd'
  | 'settings.googleTasks.testGoogleCalendar'
  | 'settings.googleTasks.googleTasksSync'
  | 'settings.googleTasks.importAndReconcileTasksWithGoogleTasks'
  | 'settings.googleTasks.enableGoogleTasksSync'
  | 'settings.googleTasks.usedForTokenRefreshAndManualOauthSetup'
  | 'settings.googleTasks.googleOauthClientId'
  | 'settings.googleTasks.clientIdAppsGoogleusercontentCom'
  | 'settings.googleTasks.oauthBearerTokenWithGoogleTasksScope'
  | 'settings.googleTasks.googleTasksAccessToken'
  | 'settings.googleTasks.ya29'
  | 'settings.googleTasks.optionalOauthRefreshToken'
  | 'settings.googleTasks.googleTasksRefreshToken'
  | 'settings.googleTasks.1'
  | 'settings.googleTasks.vaultNoteWhereImportedGoogleTasksAreWritten'
  | 'settings.googleTasks.googleTasksInboxNote'
  | 'settings.googleTasks.googleTasksInboxMd'
  | 'settings.googleTasks.countChangesWithoutWritingThemToGoogleTasks'
  | 'settings.googleTasks.dryRunMode'
  | 'settings.googleTasks.setupWizard'
  | 'settings.googleTasks.quickAdd'
  | 'settings.googleTasks.syncTasksTaggedGoogleCalendarIntoAllDayCalendarEvents'
  | 'settings.googleTasks.enableGoogleCalendarSync'
  | 'settings.googleTasks.calendarToWriteToDefaultsToPrimary'
  | 'settings.googleTasks.calendarId'
  | 'settings.googleTasks.primary'
  | 'settings.googleTasks.letGoogleCalendarUseItsDefaultReminderBehavior'
  | 'settings.googleTasks.useDefaultReminders'
  | 'settings.googleTasks.minutesBeforeTheEventToFireThePopupReminder'
  | 'settings.googleTasks.reminderMinutes'
  | 'settings.googleTasks.10'
  | 'settings.googleTasks.countPlannedEventsWithoutWritingThemToGoogleCalendar'
  | 'settings.microsoftTodo.microsoftToDoSyncExperimental'
  | 'settings.microsoftTodo.importAndExportTasksViaTheMicrosoftGraphApiRequires'
  | 'settings.microsoftTodo.activateMicrosoftToDoIntegrationUseTheSyncMicrosoftTo'
  | 'settings.microsoftTodo.enableMicrosoftToDoSync'
  | 'settings.microsoftTodo.verifyMicrosoftToDoConfiguration'
  | 'settings.microsoftTodo.testConnection'
  | 'settings.microsoftTodo.test'
  | 'settings.microsoftTodo.azureAppRegistrationClientIdForMicrosoftGraphOauthTasks'
  | 'settings.microsoftTodo.azureClientId'
  | 'settings.microsoftTodo.xxxxxxxxXxxxXxxxXxxxXxxxxxxxxxxx'
  | 'settings.microsoftTodo.pasteAMicrosoftGraphOauthAccessTokenWithTasksReadwrite'
  | 'settings.microsoftTodo.microsoftToDoAccessToken'
  | 'settings.microsoftTodo.eyj'
  | 'settings.microsoftTodo.optionalMicrosoftOauthRefreshTokenWhenTheAccessTokenExpires'
  | 'settings.microsoftTodo.microsoftToDoRefreshToken'
  | 'settings.microsoftTodo.0A'
  | 'settings.microsoftTodo.optionalIsoTimestampForMicrosoftGraphAccessTokenExpiryLeave'
  | 'settings.microsoftTodo.microsoftTokenExpiresAt'
  | 'settings.microsoftTodo.20260528t200000000z'
  | 'settings.microsoftTodo.optionalLeaveBlankToResolveTheDefaultMicrosoftToDo'
  | 'settings.microsoftTodo.microsoftToDoListId'
  | 'settings.microsoftTodo.defaultList'
  | 'settings.microsoftTodo.vaultNoteWhereImportedMicrosoftToDoTasksAreWritten'
  | 'settings.microsoftTodo.microsoftToDoInboxNote'
  | 'settings.microsoftTodo.msToDoInboxMd'
  | 'settings.microsoftTodo.whenEnabledChangesAreLoggedButNotCommittedToMicrosoft'
  | 'settings.voiceAi.voiceCapture'
  | 'settings.voiceAi.recordAudioAndConvertSpeechToAStructuredTaskThe'
  | 'settings.voiceAi.openaiWhisperApiKeyForVoiceTranscriptionFallbackLeaveBlank'
  | 'settings.voiceAi.whisperApiKeyOptional'
  | 'settings.voiceAi.sk'
  | 'settings.voiceAi.aiQueryExpansion'
  | 'settings.voiceAi.useAnAiLanguageModelToTranslateTheQuestionYou'
  | 'settings.voiceAi.activateTheAiQueryFeature'
  | 'settings.voiceAi.enableAiQueryExpansion'
  | 'settings.voiceAi.languageModelProviderToUse'
  | 'settings.voiceAi.aiProvider'
  | 'settings.voiceAi.apiKeyForTheSelectedProvider'
  | 'settings.voiceAi.aiApiKey'
  | 'settings.voiceAi.openaiCompatibleChatCompletionsEndpointOllamaDefaultHttpLocalhost11434'
  | 'settings.voiceAi.localAiEndpoint'
  | 'settings.voiceAi.modelNameEGGpt4oMiniClaudeHaiku4'
  | 'settings.voiceAi.aiModel'
  | 'settings.voiceAi.weeklyReview'
  | 'settings.voiceAi.aGuidedGtdStyleWeeklyReviewWorkflowUseTheStart'
  | 'settings.voiceAi.showTheWeeklyReviewCommandInTheCommandPalette'
  | 'settings.voiceAi.enableWeeklyReview'
  | 'settings.voiceAi.theInboxNoteToProcessDuringTheWeeklyReviewDefaults'
  | 'settings.voiceAi.inboxNotePath'
  | 'settings.voiceAi.inboxMd'
  | 'settings.voiceAi.orgModeCompatibility'
  | 'settings.voiceAi.enableOrgModeTaskFormat'
  | 'settings.caldav.caldavSync'
  | 'settings.caldav.configureCaldavCompatibleCalendarServerSettingsForTaskCalendarIntegration'
  | 'settings.caldav.activateCaldavIntegrationSettings'
  | 'settings.caldav.enableCaldavSync'
  | 'settings.caldav.baseUrlOfYourCaldavServerEGHttpsCaldav'
  | 'settings.caldav.caldavServerUrl'
  | 'settings.caldav.httpsCaldavExampleCom'
  | 'settings.caldav.explicitlyTrustLocalhostLocalLoopbackLinkLocalOrPrivateIp'
  | 'settings.caldav.allowPrivateLocalCaldavEndpoints'
  | 'settings.caldav.usernameForCaldavServerAuthentication'
  | 'settings.caldav.caldavUsername'
  | 'settings.caldav.userExampleCom'
  | 'settings.caldav.passwordForCaldavServerAuthentication'
  | 'settings.caldav.caldavPassword'
  | 'settings.caldav.'
  | 'settings.caldav.calendarCollectionPathEndingInEGUserTasksAn'
  | 'settings.caldav.calendarPath'
  | 'settings.caldav.userTasks'
  | 'settings.caldav.noteWhereTasksPulledFromTheCaldavServerAreWritten'
  | 'settings.caldav.vaultNotePath'
  | 'settings.caldav.caldavSyncMd'
  | 'settings.caldav.verifyCaldavServerConnection'
  | 'aiQuery.title'
  | 'aiQuery.description'
  | 'aiQuery.requestLabel'
  | 'aiQuery.requestPlaceholder'
  | 'aiQuery.generate'
  | 'aiQuery.thinking'
  | 'aiQuery.generating'
  | 'aiQuery.insert'
  | 'aiQuery.error'
  | 'aiQuery.apiKeyRequired'
  | 'aiQuery.browserAccessRequired'
  | 'aiQuery.emptyResponse'
  | 'aiQuery.browserAccessLabel'
  | 'aiQuery.browserAccessDescription'
  | 'aiQuery.requestTooLarge'

  // Modal - Create/Edit Task
  | 'modal.create.title'
  | 'modal.edit.title'
  | 'modal.field.description'
  | 'modal.field.descriptionPlaceholder'
  | 'modal.field.priority'
  | 'modal.field.status'
  | 'modal.field.dueDate'
  | 'modal.field.scheduledDate'
  | 'modal.field.startDate'
  | 'modal.field.createdDate'
  | 'modal.field.doneDate'
  | 'modal.field.cancelledDate'
  | 'modal.field.reminder'
  | 'modal.field.followUp'
  | 'modal.field.recurrence'
  | 'modal.field.onCompletion'
  | 'modal.field.id'
  | 'modal.field.dependsOn'
  | 'modal.field.blockedBy'
  | 'modal.field.tags'
  | 'modal.field.effort'
  | 'modal.field.actual'
  | 'modal.field.time'
  | 'modal.field.customField'
  | 'modal.field.onlyFutureDates'
  | 'modal.field.onlyFutureDatesDesc'
  | 'modal.btn.apply'
  | 'modal.btn.cancel'
  | 'modal.btn.generateId'
  | 'modal.btn.save'
  | 'modal.btn.delete'
  | 'modal.btn.close'
  | 'modal.btn.addBefore'
  | 'modal.btn.addAfter'
  | 'modal.visibleFields.description'
  | 'modal.visibleFields.saving'
  | 'modal.recurrence.commonPatterns'
  | 'modal.validation.descriptionRequired'
  | 'modal.validation.descriptionEmpty'
  | 'modal.validation.templateNameEmpty'
  | 'modal.validation.invalidRecurrence'
  | 'modal.recurrence.preview'
  | 'modal.recurrence.noRecurrence'
  | 'modal.recurrence.invalidRule'
  | 'modal.autocomplete.wikilink'
  | 'modal.autocomplete.tag'
  | 'modal.autocomplete.noteSuggestions'
  | 'modal.autocomplete.tagSuggestions'
  | 'modal.hiddenFieldLabel'
  | 'modal.quickCapture.title'
  | 'modal.quickCapture.dueDate'
  | 'modal.quickCapture.dueDatePlaceholder'
  | 'modal.quickCapture.dueInvalid'
  | 'modal.quickCapture.dueResolved'
  | 'modal.quickCapture.capture'
  | 'modal.quickAdd.title'
  | 'modal.quickAdd.description'
  | 'modal.quickAdd.placeholder'
  | 'modal.quickAdd.previewPlaceholder'
  | 'modal.quickAdd.previewHeading'
  | 'modal.quickAdd.submit'
  | 'googleCalendar.setup.localModeDescription'
  | 'priority.normal'
  | 'priority.lowest'
  | 'priority.low'
  | 'priority.medium'
  | 'priority.high'
  | 'priority.highest'

  // Actions and Buttons
  | 'action.complete'
  | 'action.archive'
  | 'action.delete'
  | 'action.edit'
  | 'action.view'
  | 'action.copyLink'
  | 'action.postpone'
  | 'action.reschedule'
  | 'action.priority'
  | 'action.tag'
  | 'action.untag'
  | 'action.status'
  | 'action.menu'
  | 'action.back'
  | 'action.previous'
  | 'action.next'
  | 'action.skip'
  | 'action.pause'
  | 'action.start'
  | 'action.logNote'
  | 'action.weeklyReview'
  | 'action.runQuery'
  | 'action.moreOptions'
  | 'action.nextInstance'
  | 'action.linkRelated'
  | 'action.createFollowUp'
  | 'action.recommended'
  | 'pomodoro.title'
  | 'pomodoro.phase.work'
  | 'pomodoro.phase.shortBreak'
  | 'pomodoro.phase.longBreak'
  | 'pomodoro.roundInfo'
  | 'pomodoro.notice.logged'
  | 'pomodoro.notice.longBreak'
  | 'pomodoro.notice.shortBreak'
  | 'pomodoro.notice.work'

  // Notifications
  | 'notice.testLogEntry'
  | 'notice.scanComplete'
  | 'notice.commandCenterGenerated'
  | 'notice.healthReportGenerated'
  | 'notice.tasksScanned'
  | 'notice.stateCacheReset'
  | 'notice.exportDone'
  | 'notice.exportedTasks'
  | 'notice.copiedAsCSV'
  | 'notice.copiedAsJSON'
  | 'notice.copiedAsMarkdown'
  | 'notice.copiedLink'
  | 'notice.syncComplete'
  | 'notice.syncError'
  | 'notice.syncConflict'
  | 'notice.todayScheduled'
  | 'notice.queryResultsCopied'
  | 'notice.settingsAdded'
  | 'notice.canvasTasksIndexed'
  | 'notice.canvasTasksImported'
  | 'notice.tasksArchived'
  | 'notice.remindersConverted'
  | 'notice.projectPromoted'

  // Error Messages
  | 'error.noActiveFile'
  | 'error.noTaskAtCursor'
  | 'error.notATaskLine'
  | 'error.noDateField'
  | 'error.cannotToggleStatus'
  | 'error.cannotCycleStatus'
  | 'error.cannotSetStatus'
  | 'error.lineAlreadyTask'
  | 'error.cursorNotOnTask'
  | 'error.tasksQueryError'
  | 'error.dslDisabled'
  | 'error.invalidRecurrence'
  | 'error.queryError'
  | 'error.taskCannotDependOnItself'
  | 'error.noTemplatesConfigured'
  | 'error.todayPlanningSyntax'
  | 'error.noSavedQueries'
  | 'error.todoistNotConfigured'
  | 'error.googleTasksNotConfigured'
  | 'error.microsoftNotConfigured'
  | 'error.appleRemindersNotConfigured'
  | 'error.icsImportNotConfigured'
  | 'error.mcpTokenGenerated'
  | 'error.noCanvasTasksFound'
  | 'error.noCompletedTasks'
  | 'error.canvasTasksReadOnly'
  | 'error.noStatisticsYet'
  | 'error.lifecycleTransferReconcile'
  | 'warning.plaintextSecrets'

  // Settings - General
  | 'settings.section.general'
  | 'settings.section.query'
  | 'settings.section.logging'
  | 'settings.section.sync'
  | 'settings.section.integrations'
  | 'settings.section.ai'
  | 'settings.section.mobile'
  | 'settings.section.accessibility'
  | 'settings.section.views'
  | 'settings.section.modal'
  | 'settings.section.templates'
  | 'settings.searchLabel'
  | 'settings.searchPlaceholder'
  | 'settings.searchClear'
  | 'settings.searchCountSingular'
  | 'settings.searchCountPlural'
  | 'settings.validation.scanInterval'

  // Settings - Localization
  | 'settings.label.language'
  | 'settings.desc.language'
  | 'settings.language.english'
  | 'settings.language.chinese'
  | 'settings.language.german'
  | 'settings.language.spanish'
  | 'settings.language.korean'
  | 'settings.language.vietnamese'
  | 'settings.language.russian'
  | 'settings.language.ukrainian'
  | 'settings.language.belarusian'
  | 'settings.language.portugueseBR'

  // Settings - File Events
  | 'settings.label.enableFileEvents'
  | 'settings.desc.enableFileEvents'
  | 'settings.label.enablePeriodicScan'
  | 'settings.desc.enablePeriodicScan'
  | 'settings.label.scanInterval'
  | 'settings.desc.scanInterval'
  | 'settings.label.excludedFolders'
  | 'settings.desc.excludedFolders'

  // Settings - Filters
  | 'settings.label.globalFilter'
  | 'settings.desc.globalFilter'
  | 'settings.label.removeGlobalFilter'
  | 'settings.desc.removeGlobalFilter'
  | 'settings.label.globalQuery'
  | 'settings.desc.globalQuery'

  // Settings - Dates
  | 'settings.label.dateFormat'
  | 'settings.label.timeFormat'
  | 'settings.label.useFilenameAsScheduled'
  | 'settings.label.setCreatedDate'
  | 'settings.desc.setCreatedDate'
  | 'settings.label.setDoneDate'
  | 'settings.desc.setDoneDate'
  | 'settings.label.setCancelledDate'
  | 'settings.desc.setCancelledDate'
  | 'settings.label.writeWikiLinks'
  | 'settings.desc.writeWikiLinks'
  | 'settings.label.appendTimeWithDates'
  | 'settings.desc.appendTimeWithDates'
  | 'settings.label.onlyFutureDates'
  | 'settings.label.removeDateOnRecurrence'
  | 'settings.desc.removeDateOnRecurrence'
  | 'settings.label.skipPastOccurrences'
  | 'settings.desc.skipPastOccurrences'
  | 'settings.label.advanceRecurrenceOnCancel'
  | 'settings.desc.advanceRecurrenceOnCancel'
  | 'settings.label.trackRecurrenceCount'
  | 'settings.desc.trackRecurrenceCount'

  // Settings - Modal Fields
  | 'settings.label.modalFields'
  | 'settings.desc.modalFields'
  | 'settings.modal.showAll'
  | 'settings.modal.hideAll'
  | 'settings.modal.priority'
  | 'settings.modal.dueDate'
  | 'settings.modal.scheduledDate'
  | 'settings.modal.startDate'
  | 'settings.modal.createdDate'
  | 'settings.modal.doneDate'
  | 'settings.modal.cancelledDate'
  | 'settings.modal.reminder'
  | 'settings.modal.time'
  | 'settings.modal.recurrence'
  | 'settings.modal.onCompletion'
  | 'settings.modal.id'
  | 'settings.modal.blockedBy'
  | 'settings.modal.blocking'
  | 'settings.modal.effort'
  | 'settings.modal.actual'
  | 'settings.modal.followUp'

  // Settings - Task States
  | 'settings.label.taskStates'
  | 'settings.desc.taskStates'
  | 'settings.state.add'
  | 'settings.state.edit'
  | 'settings.state.delete'
  | 'settings.state.name'
  | 'settings.state.type'
  | 'settings.state.icon'
  | 'settings.state.marker'
  | 'settings.state.nextMarker'
  | 'settings.state.saved'
  | 'settings.state.invalid'
  | 'settings.state.moved'

  // Settings - Templates
  | 'settings.label.templates'
  | 'settings.desc.templates'
  | 'settings.template.add'
  | 'settings.template.edit'
  | 'settings.template.delete'
  | 'settings.template.name'
  | 'settings.template.description'
  | 'settings.template.priority'
  | 'settings.template.recurrence'
  | 'settings.template.tags'
  | 'settings.template.onCompletion'

  // Settings - Saved Queries
  | 'settings.label.savedQueries'
  | 'settings.desc.savedQueries'
  | 'settings.query.add'
  | 'settings.query.edit'
  | 'settings.query.delete'
  | 'settings.query.name'
  | 'settings.query.description'
  | 'settings.query.content'

  // Settings - Logging
  | 'settings.label.completionLog'
  | 'settings.label.enableCompletionLogging'
  | 'settings.desc.enableCompletionLogging'
  | 'settings.desc.completionLoggingDisabled'
  | 'settings.googleTasks.listId'
  | 'settings.googleTasks.listIdDesc'
  | 'settings.googleTasks.listIdPlaceholder'
  | 'settings.integration.enabledNotVerified'
  | 'settings.integration.disabled'
  | 'settings.label.logTemplate'
  | 'settings.desc.logTemplate'
  | 'settings.label.logHeading'
  | 'settings.desc.logHeading'
  | 'settings.label.logFilePath'
  | 'settings.desc.logFilePath'
  | 'settings.label.appendStats'
  | 'settings.desc.appendStats'
  | 'settings.label.appendDailyNote'
  | 'settings.desc.appendDailyNote'

  // Settings - Completion Actions
  | 'settings.label.onCompletion'
  | 'settings.label.autoCompleteParent'
  | 'settings.desc.autoCompleteParent'
  | 'settings.label.nextInstanceAction'
  | 'settings.label.archiveAction'
  | 'settings.label.collectAction'
  | 'settings.label.archiveHeading'
  | 'settings.label.collectHeading'

  // Settings - Accessibility
  | 'settings.label.enableKeyboardNav'
  | 'settings.desc.enableKeyboardNav'
  | 'settings.label.enableA11y'
  | 'settings.desc.enableA11y'
  | 'settings.label.enableMobileNotifications'
  | 'settings.desc.enableMobileNotifications'

  // Settings - Views
  | 'settings.label.inlineProgress'
  | 'settings.desc.inlineProgress'
  | 'settings.label.functionExpressions'
  | 'settings.desc.functionExpressions'
  | 'settings.label.queryResultCounts'
  | 'settings.desc.queryResultCounts'
  | 'settings.label.taskMetadataSuggestions'
  | 'settings.desc.taskMetadataSuggestions'
  | 'settings.label.caldavEndpointTrust'
  | 'settings.desc.caldavEndpointTrust'
  | 'settings.desc.caldavServerUrlTrust'

  // Query and Results
  | 'query.noTasks'
  | 'query.taskCount'
  | 'query.taskCountPlural'
  | 'query.toolbar.filter'
  | 'query.toolbar.copy'
  | 'query.toolbar.export'
  | 'query.toolbar.jsonExport'
  | 'query.toolbar.csvExport'
  | 'query.toolbar.canvasExport'
  | 'query.error.prefix'
  | 'query.error.dslDisabled'
  | 'query.error.invalidRecurrence'
  | 'query.warning.recurrenceWarning'

  // Views
  | 'view.list'
  | 'view.table'
  | 'view.kanban'
  | 'view.calendar'
  | 'view.gantt'
  | 'view.stats'
  | 'view.graph'
  | 'view.eisenhower'
  | 'view.timeline'
  | 'calendar.rescheduleHint'
  | 'dashboard.keyboardLayoutHint'

  // Kanban
  | 'kanban.column'
  | 'kanban.addCard'
  | 'kanban.moveCard'
  | 'kanban.allTasksShown'

  // Eisenhower Matrix
  | 'eisenhower.q1'
  | 'eisenhower.q2'
  | 'eisenhower.q3'
  | 'eisenhower.q4'
  | 'eisenhower.urgent'

  // Status and States
  | 'status.todo'
  | 'status.inProgress'
  | 'status.done'
  | 'status.cancelled'
  | 'status.blocked'
  | 'status.deferred'
  | 'status.onHold'

  // Keyboard Shortcuts
  | 'keyboard.closeModal'
  | 'keyboard.toggleCheckbox'
  | 'keyboard.cycleStatus'
  | 'keyboard.openDatePicker'
  | 'keyboard.editTask'
  | 'keyboard.deleteTask'
  | 'keyboard.moveUp'
  | 'keyboard.moveDown'
  | 'keyboard.focusSearch'

  // Confirmation Dialogs
  | 'confirm.deleteTask'
  | 'confirm.resetSettings'
  | 'confirm.reset'
  | 'confirm.cancel'

  // Help and Documentation
  | 'help.title'
  | 'help.keyboard'
  | 'help.taskFormat'
  | 'help.queryDSL'
  | 'help.viewMore'
  | 'help.contribute'
  | 'help.contributors'
  | 'help.license'
  | 'help.version'
  | 'voice.error.recordingSizeLimit'
  | 'voice.error.recordingTooLarge';

export type Catalogue = Partial<Record<TranslationKey, string>>;

const EN: Catalogue = {
  // Core UI
  'ui.panel.tasks': 'Tasks',
  'ui.tab.today': 'Today',
  'ui.tab.upcoming': 'Upcoming',
  'ui.tab.all': 'All',
  'ui.tab.agenda': 'Agenda',
  'ui.tab.thisFile': 'This file',
  'ui.tab.habits': 'Habits',
  'ui.loading': 'Loading…',
  'ui.retry': 'Retry',
  'ui.sidebarLoadError': 'Task loading failed: {{error}}',
  'ui.noFileActive': 'No file is currently active. Open a note to see its tasks here.',
  'ui.noMatchingTasks': 'No matching tasks',
  'ui.noTasksForToday': 'No tasks scheduled for today.',
  'ui.taskCountSingular': '{{count}} task',
  'ui.taskCountPlural': '{{count}} tasks',
  'ui.clearSearch': 'Clear task search',
  'ui.clearGlyph': '✕',
  'ui.refreshTasks': 'Refresh tasks',
  'ui.skipToResults': 'Skip to task results',
  'ui.viewMode': 'Task view mode',
  'ui.view.list': 'List view',
  'ui.view.kanban': 'Kanban view',
  'ui.view.calendar': 'Calendar view',
  'ui.taskFilters': 'Task filters',
  'ui.resultPages': 'Task result pages',
  'ui.searchLabel': 'Search tasks',
  'ui.searchPlaceholder': 'Search tasks…',
  'ui.selectAllQueryResults': 'Select all query results',
  'ui.swipeComplete': 'Release to complete',
  'ui.swipeDefer': 'Release to defer',
  'ui.swipeCompleted': 'Completed {{task}}.',
  'ui.undo': 'Undo',
  'ui.deferFailed': 'Could not defer task: {{error}}',
  'planning.undoLastScheduleChange': 'Undo last schedule change',
  'planning.undidScheduleChange': 'Undid schedule change for {{task}}.',
  'task.action.markComplete': 'Mark {{task}} complete',
  'task.action.markIncomplete': 'Mark {{task}} incomplete',
  'task.action.open': 'Open task: {{task}}',
  'task.action.openSource': 'Open source: {{path}}',
  'task.action.defer': 'Defer {{task}}',
  'task.action.edit': 'Edit {{task}}',
  'table.addTagTitle': 'Add tag to selected',
  'table.removeTagTitle': 'Remove tag from selected',
  'table.selectedCount': '{{count}} selected · {{action}}',
  'table.tagToAdd': 'Tag to add',
  'table.tagToRemove': 'Tag to remove',
  'table.add': 'Add',
  'table.remove': 'Remove',
  'table.noTagSuggestions': 'No tag suggestions available',
  'table.suggestions': 'Suggestions',
  'table.cancel': 'Cancel',
  'table.customFieldTitle': 'Set custom field on selected',
  'table.customFieldDescription': '{{count}} selected · Apply one Dataview-style field to all selected tasks.',
  'table.customFieldName': 'Custom field name',
  'table.customFieldValue': 'Custom field value',
  'table.apply': 'Apply',
  'table.fieldNameRequired': 'Enter a field name.',
  'table.addValue': 'Add {{label}} value',
  'table.noValuesSelected': 'No values selected',
  'table.removeValue': 'Remove {{value}}',
  'table.save': 'Save',
  'table.noMatchingTasks': 'No tasks match the current table filters.',
  'table.bulkPending': '{{operation}} is updating {{count}} selected tasks…',
  'table.bulkSuccess': '{{operation}} finished: {{count}} tasks updated. Selection retained.',
  'table.bulkPartial': '{{operation}} finished with a partial result: {{succeeded}} succeeded, {{failed}} failed, {{skipped}} skipped out of {{attempted}}. Selection retained; review changed tasks before retrying.',
  'table.bulkFailed': '{{operation}} could not finish for {{count}} selected tasks: {{error}}. Some changes may have applied. Selection retained; review before retrying.',
  'advancedFind.title': 'Advanced task find',
  'advancedFind.resultsLabel': 'Advanced task find results',
  'advancedFind.text': 'Text',
  'advancedFind.textPlaceholder': 'Search description or path',
  'advancedFind.priority': 'Priority',
  'advancedFind.dueFrom': 'Due from',
  'advancedFind.dueTo': 'Due to',
  'advancedFind.tag': 'Tag',
  'advancedFind.tagPlaceholder': '#tag',
  'advancedFind.folder': 'Folder',
  'advancedFind.folderPlaceholder': 'Projects',
  'advancedFind.status': 'Status',
  'advancedFind.any': 'Any',
  'advancedFind.countSingular': '{{count}} task found',
  'advancedFind.countPlural': '{{count}} tasks found',
  'advancedFind.moreResults': 'Showing first 100 of {{count}} tasks. Narrow filters to see more.',
  'advancedFind.cannotOpen': 'Task Manager: cannot open {{path}}',
  'weeklyReview.title': '📋 Weekly Review',
  'weeklyReview.progress': 'Step {{current}} of {{total}}',
  'weeklyReview.overdue.title': '1. Overdue Tasks',
  'weeklyReview.overdue.description': 'These tasks are past their due date. Reschedule, complete, or delete them.',
  'weeklyReview.inbox.title': '2. Inbox Processing',
  'weeklyReview.inbox.description': 'These tasks are in your inbox. Move them to projects or schedule them.',
  'weeklyReview.undated.title': '3. Undated Tasks',
  'weeklyReview.undated.description': "These tasks have no date. Add a due/scheduled date or decide if they're still relevant.",
  'weeklyReview.complete.title': '✅ Review Complete!',
  'weeklyReview.complete.summary': 'Reviewed {{count}} tasks total.',
  'weeklyReview.complete.stats': 'Overdue: {{overdue}} | Inbox: {{inbox}} | Undated: {{undated}}',
  'weeklyReview.openTask': 'Open {{task}} in {{note}}',
  'weeklyReview.moreTasks': '… and {{count}} more',
  'weeklyReview.next': 'Next →',
  'weeklyReview.finish': 'Finish',
  'onboarding.title': 'Getting started',
  'onboarding.progress': 'Step {{current}} of {{total}}',
  'onboarding.firstTask.title': '1. Create your first task',
  'onboarding.firstTask.description': 'Open local task capture and save an ordinary Markdown task in your vault.',
  'onboarding.firstTask.action': 'Create a task',
  'onboarding.sidebar.title': '2. Open the task Sidebar',
  'onboarding.sidebar.description': 'Reveal your local tasks in the Task Manager Sidebar.',
  'onboarding.sidebar.action': 'Open task Sidebar',
  'onboarding.query.title': '3. Insert your first query',
  'onboarding.query.description': 'Insert a local task-list query for unfinished tasks. If no Markdown editor is active, copy the query instead.',
  'onboarding.query.action': 'Insert or copy query',
  'onboarding.remindLater': 'Remind me later',
  'onboarding.doNotShowAgain': "Don't show again",
  'onboarding.finish': 'Finish',
  'onboarding.status.task': 'Local task capture opened.',
  'onboarding.status.panel': 'Task Sidebar opened.',
  'onboarding.status.inserted': 'Task query inserted in the active note.',
  'onboarding.status.copied': 'Task query copied to the clipboard.',
  'onboarding.status.copyFailed': 'No active Markdown editor and clipboard access is unavailable.',
  'onboarding.command.open': 'Open getting started',
  'settings.appleReminders.shortcutName': 'Shortcut name',
  'settings.appleReminders.shortcutDescription': 'Exact Apple Shortcut name opened by the export command. Rename this setting if your Shortcut uses a different name.',
  'settings.appleReminders.shortcutPlaceholder': 'Export Reminders to Obsidian',
  'queryBuilder.title': 'Query Builder',
  'queryBuilder.filters': 'Filters',
  'queryBuilder.addFilter': 'Add filter',
  'queryBuilder.sort': 'Sort',
  'queryBuilder.addSort': 'Add sort',
  'queryBuilder.group': 'Group By',
  'queryBuilder.addGroup': 'Add group',
  'queryBuilder.viewMode': 'View Mode',
  'queryBuilder.view': 'View',
  'queryBuilder.layout': 'Layout',
  'queryBuilder.limit': 'Limit',
  'queryBuilder.maxResults': 'Max results',
  'queryBuilder.limitPlaceholder': 'Leave blank for no limit',
  'queryBuilder.preview': 'Query Preview',
  'queryBuilder.insert': 'Insert Query',
  'queryBuilder.removeFilter': 'Remove filter: {{clause}}',
  'queryBuilder.removeSort': 'Remove sort: {{clause}}',
  'queryBuilder.removeGroup': 'Remove group: {{clause}}',
  'queryBuilder.status.updated': 'Query preview updated.',
  'queryBuilder.status.added': 'Added {{kind}}: {{clause}}.',
  'queryBuilder.status.removed': 'Removed {{kind}}: {{clause}}.',
  'ui.agenda.dateHeading': 'Today — {{date}}',
  'ui.agenda.noTasks': 'No tasks scheduled for today.',
  'ui.agenda.morning': '🌅 Morning',
  'ui.agenda.afternoon': '☀️ Afternoon',
  'ui.agenda.evening': '🌙 Evening',
  'ui.agenda.noTime': '🕐 No time',
  'dashboard.title': 'Dashboard',
  'dashboard.scope.today': 'Today',
  'dashboard.scope.week': 'Week',
  'dashboard.scope.month': 'Month',
  'dashboard.rangeLabel': 'Dashboard view range',
  'dashboard.action.refresh': 'Refresh dashboard',
  'dashboard.action.edit': 'Edit widgets',
  'dashboard.action.done': 'Done',
  'dashboard.a11y.deadlineStrip': 'Upcoming dated work by day',
  'dashboard.a11y.completionHeatmap': 'Task completions by day for the last five weeks',
  'dashboard.a11y.goalStreak': 'Daily goal completion history',
  'planningBoard.action.advanceStatus': 'Advance task status',
  'kanban.moveTo': 'Move to',
  'gantt.reschedule': 'Reschedule {{task}}',
  'timeline.reschedule': 'Reschedule {{task}} time',
  'notice.enableGoogleCalendar': 'Task Manager: enable Google Calendar sync in settings first.',
  'notice.enableAiTaskSearch': 'Task Manager: enable AI task search in settings first.',
  'notice.enableWeeklyReview': 'Task Manager: enable Weekly review in settings first.',
  'notice.enableAppleReminders': 'Task Manager: enable Apple Reminders in settings first.',
  'notice.enableCalDav': 'Task Manager: enable CalDAV sync in settings first.',
  'dashboard.delete.confirmTitle': 'Delete selected tasks?',
  'dashboard.delete.confirmAction': 'Delete tasks',
  'dashboard.delete.deleting': 'Deleting selected tasks…',
  'dashboard.delete.undo': 'Undo delete',
  'dashboard.delete.retryRecovery': 'Retry recovery',
  'dashboard.delete.recoveryCompleted': 'Recovery completed.',
  'dashboard.delete.recoveryRetained': 'Task Manager: delete recovery remains pending for {{paths}}. Reopen the dashboard to retry recovery.',
  'diagnostics.functionExpressions': 'Function expressions',
  'diagnostics.buildIdentity': 'Build identity',
  'diagnostics.sourceDigest': 'Source content SHA-256',
  'diagnostics.syncRunsFilter': 'Filter recent sync runs',
  'diagnostics.syncRunsLabel': 'Recent sync runs',
  'habits.loading': 'Loading habit history…',
  'habits.none': 'No habits found.',
  'habits.retry': 'Retry habit history',
  'notice.applePayloadTooLarge': 'Task Manager: Apple Reminders payload exceeds the 1 MiB import limit. Split the export and retry.',
  'settings.integration.obsidianBasesIntegration': "Obsidian Bases integration",
  'settings.integration.exposesTaskDataToObsidianBasesQueriesRequiresObsidianWith': "Exposes task data to Obsidian Bases queries. Requires Obsidian with Bases support — degrades gracefully when unavailable.",
  'settings.integration.enableObsidianBasesIntegration': "Enable Obsidian Bases integration",
  'settings.integration.regenerateTheTaskManagerBasesIndexAfterTaskCacheUpdates': "Regenerate the Task Manager Bases index after task-cache updates. Writes only generated files under Task Manager Bases/.",
  'settings.integration.autoRefreshBasesExport': "Auto-refresh Bases export",
  'settings.integration.millisecondsToWaitBeforeRefreshingGeneratedBasesFilesAfterCache': "Milliseconds to wait before refreshing generated Bases files after cache updates.",
  'settings.integration.basesRefreshDebounce': "Bases refresh debounce",
  'settings.integration.500': "500",
  'settings.integration.registerTaskDataWithDatacoreTheNextGenerationDataviewReplacement': "Register task data with Datacore (the next-generation Dataview replacement by blacksmithgu) when it is installed. Degrades gracefully when Datacore is absent.",
  'settings.integration.enableDatacoreIntegration': "Enable Datacore integration",
  'settings.integration.queryBehaviour': "Query behaviour",
  'settings.integration.whenFilteringByDateEGDueBeforeUndatedSubtasks': "When filtering by date (e.g. due before), undated subtasks inherit their parent task's dates so they are included in results alongside the parent.",
  'settings.integration.inheritParentDatesToSubtasks': "Inherit parent dates to subtasks",
  'settings.integration.whenShowTreeIsActiveOnlyShowChildTasksThat': "When 'show tree' is active, only show child tasks that also pass the query filters (default: show all children of a matching parent).",
  'settings.integration.filterSubtasksInTreeView': "Filter subtasks in tree view",
  'settings.integration.whenEnabledPlainLanguageQueryTextLikeOverdueHighPriority': "When enabled, plain-language query text like “overdue high priority tasks” is conservatively translated to normal query DSL. Off by default.",
  'settings.integration.enableNlpQueryFallback': "Enable NLP query fallback",
  'settings.integration.whenEnabledDraggingAKanbanCardBetweenStatusColumnsMay': "When enabled, dragging a Kanban card between status columns may move its single markdown line under an existing matching heading in the source file. Off by default.",
  'settings.integration.enableKanbanFileWriteback': "Enable Kanban file writeback",
  'settings.integration.exportImport': "Export & import",
  'settings.integration.filePathForTheExportTasksToJsonCommandOutput': "File path for the 'Export tasks to JSON' command output.",
  'settings.integration.jsonExportPath': "JSON export path",
  'settings.integration.tasksExportJson': "Tasks Export.json",
  'settings.integration.filePathForTheExportTasksToYamlCommandOutput': "File path for the 'Export tasks to YAML' command output.",
  'settings.integration.yamlExportPath': "YAML export path",
  'settings.integration.tasksExportYaml': "Tasks Export.yaml",
  'settings.integration.arbitraryRemoteIcsFetchingIsDisabledBecauseObsidianRequesturlCannot': "Arbitrary remote ICS fetching is disabled because Obsidian requestUrl cannot pin validated DNS or reject redirect hops. Existing values are retained for migration only; download/import through a reviewed local workflow instead.",
  'settings.integration.remoteIcsImportUrlDisabled': "Remote ICS import URL (disabled)",
  'settings.integration.httpsCalendarExampleComBasicIcs': "https://calendar.example.com/basic.ics",
  'settings.integration.noteWhereImportedCalendarEventsWillBeWrittenAsTasks': "Note where imported calendar events will be written as tasks.",
  'settings.integration.icsImportTargetNote': "ICS import target note",
  'settings.integration.calendarImportMd': "Calendar Import.md",
  'settings.integration.vaultPathWhereThePublishedIcsCalendarFeedIsWritten': "Vault path where the published ICS calendar feed is written when you run “Publish ICS calendar feed”. Must end with .ics.",
  'settings.integration.icsFeedExportPath': "ICS feed export path",
  'settings.integration.taskFeedIcs': "Task Feed.ics",
  'settings.googleTasks.openCalendarQuickAdd': "Open calendar quick add",
  'settings.googleTasks.testGoogleCalendar': "Test Google Calendar",
  'settings.googleTasks.googleTasksSync': "Google Tasks sync",
  'settings.googleTasks.importAndReconcileTasksWithGoogleTasks': "Import and reconcile tasks with Google Tasks.",
  'settings.googleTasks.enableGoogleTasksSync': "Enable Google Tasks sync",
  'settings.googleTasks.usedForTokenRefreshAndManualOauthSetup': "Used for token refresh and manual OAuth setup.",
  'settings.googleTasks.googleOauthClientId': "Google OAuth client ID",
  'settings.googleTasks.clientIdAppsGoogleusercontentCom': "client-id.apps.googleusercontent.com",
  'settings.googleTasks.oauthBearerTokenWithGoogleTasksScope': "OAuth bearer token with Google Tasks scope.",
  'settings.googleTasks.googleTasksAccessToken': "Google Tasks access token",
  'settings.googleTasks.ya29': "ya29...",
  'settings.googleTasks.optionalOauthRefreshToken': "Optional OAuth refresh token.",
  'settings.googleTasks.googleTasksRefreshToken': "Google Tasks refresh token",
  'settings.googleTasks.1': "1//...",
  'settings.googleTasks.vaultNoteWhereImportedGoogleTasksAreWritten': "Vault note where imported Google Tasks are written.",
  'settings.googleTasks.googleTasksInboxNote': "Google Tasks inbox note",
  'settings.googleTasks.googleTasksInboxMd': "Google Tasks Inbox.md",
  'settings.googleTasks.countChangesWithoutWritingThemToGoogleTasks': "Count changes without writing them to Google Tasks.",
  'settings.googleTasks.dryRunMode': "Dry-run mode",
  'settings.googleTasks.setupWizard': "Setup wizard",
  'settings.googleTasks.quickAdd': "Quick add",
  'settings.googleTasks.syncTasksTaggedGoogleCalendarIntoAllDayCalendarEvents': "Sync tasks tagged #google-calendar into all-day calendar events.",
  'settings.googleTasks.enableGoogleCalendarSync': "Enable Google Calendar sync",
  'settings.googleTasks.calendarToWriteToDefaultsToPrimary': "Calendar to write to. Defaults to primary.",
  'settings.googleTasks.calendarId': "Calendar ID",
  'settings.googleTasks.primary': "primary",
  'settings.googleTasks.letGoogleCalendarUseItsDefaultReminderBehavior': "Let Google Calendar use its default reminder behavior.",
  'settings.googleTasks.useDefaultReminders': "Use default reminders",
  'settings.googleTasks.minutesBeforeTheEventToFireThePopupReminder': "Minutes before the event to fire the popup reminder.",
  'settings.googleTasks.reminderMinutes': "Reminder minutes",
  'settings.googleTasks.10': "10",
  'settings.googleTasks.countPlannedEventsWithoutWritingThemToGoogleCalendar': "Count planned events without writing them to Google Calendar.",
  'settings.microsoftTodo.microsoftToDoSyncExperimental': "Microsoft To Do sync ⚠️ Experimental",
  'settings.microsoftTodo.importAndExportTasksViaTheMicrosoftGraphApiRequires': "Import and export tasks via the Microsoft Graph API. Requires an Azure app registration with Tasks.ReadWrite permission.",
  'settings.microsoftTodo.activateMicrosoftToDoIntegrationUseTheSyncMicrosoftTo': "Activate Microsoft To Do integration. Use the 'Sync Microsoft To Do' command to run a sync.",
  'settings.microsoftTodo.enableMicrosoftToDoSync': "Enable Microsoft To Do sync",
  'settings.microsoftTodo.verifyMicrosoftToDoConfiguration': "Verify Microsoft To Do configuration",
  'settings.microsoftTodo.testConnection': "Test Connection",
  'settings.microsoftTodo.test': "🔗 Test",
  'settings.microsoftTodo.azureAppRegistrationClientIdForMicrosoftGraphOauthTasks': "Azure app registration client ID for Microsoft Graph OAuth (Tasks.ReadWrite scope required).",
  'settings.microsoftTodo.azureClientId': "Azure client ID",
  'settings.microsoftTodo.xxxxxxxxXxxxXxxxXxxxXxxxxxxxxxxx': "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  'settings.microsoftTodo.pasteAMicrosoftGraphOauthAccessTokenWithTasksReadwrite': "Paste a Microsoft Graph OAuth access token with Tasks.ReadWrite scope. See docs/microsoft-todo.md.",
  'settings.microsoftTodo.microsoftToDoAccessToken': "Microsoft To Do access token",
  'settings.microsoftTodo.eyj': "eyJ...",
  'settings.microsoftTodo.optionalMicrosoftOauthRefreshTokenWhenTheAccessTokenExpires': "Optional Microsoft OAuth refresh token. When the access token expires, Task Manager refreshes it before sync.",
  'settings.microsoftTodo.microsoftToDoRefreshToken': "Microsoft To Do refresh token",
  'settings.microsoftTodo.0A': "0.A...",
  'settings.microsoftTodo.optionalIsoTimestampForMicrosoftGraphAccessTokenExpiryLeave': "Optional ISO timestamp for Microsoft Graph access-token expiry. Leave blank for non-expiring/manual tokens.",
  'settings.microsoftTodo.microsoftTokenExpiresAt': "Microsoft token expires at",
  'settings.microsoftTodo.20260528t200000000z': "2026-05-28T20:00:00.000Z",
  'settings.microsoftTodo.optionalLeaveBlankToResolveTheDefaultMicrosoftToDo': "Optional. Leave blank to resolve the default Microsoft To Do list via Graph.",
  'settings.microsoftTodo.microsoftToDoListId': "Microsoft To Do list ID",
  'settings.microsoftTodo.defaultList': "default list",
  'settings.microsoftTodo.vaultNoteWhereImportedMicrosoftToDoTasksAreWritten': "Vault note where imported Microsoft To Do tasks are written.",
  'settings.microsoftTodo.microsoftToDoInboxNote': "Microsoft To Do inbox note",
  'settings.microsoftTodo.msToDoInboxMd': "MS To Do Inbox.md",
  'settings.microsoftTodo.whenEnabledChangesAreLoggedButNotCommittedToMicrosoft': "When enabled, changes are logged but not committed to Microsoft To Do. Useful for testing.",
  'settings.voiceAi.voiceCapture': "Voice capture",
  'settings.voiceAi.recordAudioAndConvertSpeechToAStructuredTaskThe': "Record audio and convert speech to a structured task. The browser/OS Web Speech provider may process audio in a vendor cloud even when no API key is required. The optional Whisper fallback sends recorded audio to OpenAI. Use voice capture only for content you are comfortable sharing with the active speech provider.",
  'settings.voiceAi.openaiWhisperApiKeyForVoiceTranscriptionFallbackLeaveBlank': "OpenAI Whisper API key for voice transcription fallback. Leave blank to use the browser Web Speech API only.",
  'settings.voiceAi.whisperApiKeyOptional': "Whisper API key (optional)",
  'settings.voiceAi.sk': "sk-...",
  'settings.voiceAi.aiQueryExpansion': "AI query expansion",
  'settings.voiceAi.useAnAiLanguageModelToTranslateTheQuestionYou': "Use an AI language model to translate the question you enter into Task Manager query DSL. Remote OpenAI/Anthropic providers receive that question; configured local providers receive it at the validated local endpoint. Task Manager does not send the whole vault for query expansion. Use the 'AI task search' command.",
  'settings.voiceAi.activateTheAiQueryFeature': "Activate the AI query feature.",
  'settings.voiceAi.enableAiQueryExpansion': "Enable AI query expansion",
  'settings.voiceAi.languageModelProviderToUse': "Language model provider to use.",
  'settings.voiceAi.aiProvider': "AI provider",
  'settings.voiceAi.apiKeyForTheSelectedProvider': "API key for the selected provider.",
  'settings.voiceAi.aiApiKey': "AI API key",
  'settings.voiceAi.openaiCompatibleChatCompletionsEndpointOllamaDefaultHttpLocalhost11434': "OpenAI-compatible chat completions endpoint. Ollama default: http://localhost:11434/v1/chat/completions. LM Studio default: http://localhost:1234/v1/chat/completions.",
  'settings.voiceAi.localAiEndpoint': "Local AI endpoint",
  'settings.voiceAi.modelNameEGGpt4oMiniClaudeHaiku4': "Model name (e.g. gpt-4o-mini, claude-haiku-4-5-20251001, llama3.1, local-model).",
  'settings.voiceAi.aiModel': "AI model",
  'settings.voiceAi.weeklyReview': "Weekly review",
  'settings.voiceAi.aGuidedGtdStyleWeeklyReviewWorkflowUseTheStart': "A guided GTD-style weekly review workflow. Use the 'Start weekly review' command to begin a session.",
  'settings.voiceAi.showTheWeeklyReviewCommandInTheCommandPalette': "Show the weekly review command in the command palette.",
  'settings.voiceAi.enableWeeklyReview': "Enable weekly review",
  'settings.voiceAi.theInboxNoteToProcessDuringTheWeeklyReviewDefaults': "The inbox note to process during the weekly review. Defaults to the quick-capture inbox if blank.",
  'settings.voiceAi.inboxNotePath': "Inbox note path",
  'settings.voiceAi.inboxMd': "Inbox.md",
  'settings.voiceAi.orgModeCompatibility': "Org-mode compatibility",
  'settings.voiceAi.enableOrgModeTaskFormat': "Enable org-mode task format",
  'settings.caldav.caldavSync': "CalDAV sync",
  'settings.caldav.configureCaldavCompatibleCalendarServerSettingsForTaskCalendarIntegration': "Configure CalDAV-compatible calendar server settings for task calendar integration.",
  'settings.caldav.activateCaldavIntegrationSettings': "Activate CalDAV integration settings.",
  'settings.caldav.enableCaldavSync': "Enable CalDAV sync",
  'settings.caldav.baseUrlOfYourCaldavServerEGHttpsCaldav': "Base URL of your CalDAV server (e.g., https://caldav.example.com/)",
  'settings.caldav.caldavServerUrl': "CalDAV server URL",
  'settings.caldav.httpsCaldavExampleCom': "https://caldav.example.com/",
  'settings.caldav.explicitlyTrustLocalhostLocalLoopbackLinkLocalOrPrivateIp': "Explicitly trust localhost, .local, loopback, link-local, or private IP destinations. Enable only for a server you control; hostname DNS cannot be pinned by the Obsidian request API.",
  'settings.caldav.allowPrivateLocalCaldavEndpoints': "Allow private/local CalDAV endpoints",
  'settings.caldav.usernameForCaldavServerAuthentication': "Username for CalDAV server authentication.",
  'settings.caldav.caldavUsername': "CalDAV username",
  'settings.caldav.userExampleCom': "user@example.com",
  'settings.caldav.passwordForCaldavServerAuthentication': "Password for CalDAV server authentication.",
  'settings.caldav.caldavPassword': "CalDAV password",
  'settings.caldav.': "••••••••",
  'settings.caldav.calendarCollectionPathEndingInEGUserTasksAn': "Calendar collection path ending in / (e.g., /user/tasks/). An explicit .ics file uses legacy WebDAV snapshot mode, not CalDAV collection synchronization.",
  'settings.caldav.calendarPath': "Calendar path",
  'settings.caldav.userTasks': "/user/tasks/",
  'settings.caldav.noteWhereTasksPulledFromTheCaldavServerAreWritten': "Note where tasks pulled from the CalDAV server are written, and read from when pushing tasks to the server.",
  'settings.caldav.vaultNotePath': "Vault note path",
  'settings.caldav.caldavSyncMd': "CalDAV Sync.md",
  'settings.caldav.verifyCaldavServerConnection': "Verify CalDAV server connection",
  'aiQuery.title': "AI Task Search",
  'aiQuery.description': "Describe what tasks you want to find in plain English. Only your question and fixed query-grammar instructions are sent; vault contents are not sent.",
  'aiQuery.requestLabel': "Task search request",
  'aiQuery.requestPlaceholder': "e.g. Show me overdue high-priority tasks in the Projects folder",
  'aiQuery.generate': "Generate Query",
  'aiQuery.thinking': "Thinking…",
  'aiQuery.generating': "Generating query…",
  'aiQuery.insert': "Insert into note",
  'aiQuery.error': "Error: {{message}}",
  'aiQuery.apiKeyRequired': "An API key is required for the selected AI provider.",
  'aiQuery.browserAccessRequired': "Enable direct Anthropic browser access in AI settings before sending a request.",
  'aiQuery.emptyResponse': "The AI provider returned no query text.",
  'aiQuery.browserAccessLabel': "Allow direct Anthropic browser access",
  'aiQuery.browserAccessDescription': "Opt in to sending the question and API key directly from this Obsidian client to Anthropic. Other client-side code may access the key; use a dedicated restricted key. Some organizations prohibit browser requests even with this opt-in.",
  'aiQuery.requestTooLarge': 'Task search request exceeds the 32 KiB limit.',

  // Modals
  'modal.create.title': 'Create task',
  'modal.edit.title': 'Edit task',
  'modal.field.description': 'Description',
  'modal.field.descriptionPlaceholder': 'Add a task description',
  'modal.field.priority': 'Priority',
  'modal.field.status': 'Status',
  'modal.field.dueDate': 'Due',
  'modal.field.scheduledDate': 'Scheduled',
  'modal.field.startDate': 'Start',
  'modal.field.createdDate': 'Created',
  'modal.field.doneDate': 'Done',
  'modal.field.cancelledDate': 'Cancelled',
  'modal.field.reminder': 'Reminder (⏰)',
  'modal.field.followUp': 'Follow-up (👀)',
  'modal.field.recurrence': 'Recurrence',
  'modal.field.onCompletion': 'On completion',
  'modal.field.id': 'Id',
  'modal.field.dependsOn': 'Before this (depends on)',
  'modal.field.blockedBy': 'After this (blocked by)',
  'modal.field.tags': 'Tags',
  'modal.field.effort': 'Effort (⏱️)',
  'modal.field.actual': 'Actual (🕐)',
  'modal.field.time': 'Time (⌚)',
  'modal.field.customField': 'Custom field',
  'modal.field.onlyFutureDates': 'Only future dates',
  'modal.field.onlyFutureDatesDesc': 'Interpret relative dates in date fields as future dates where possible.',
  'modal.btn.apply': 'Apply',
  'modal.btn.cancel': 'Cancel',
  'modal.btn.generateId': 'Generate ID',
  'modal.btn.save': 'Save',
  'modal.btn.delete': 'Delete',
  'modal.btn.close': 'Close',
  'modal.btn.addBefore': 'Add before this…',
  'modal.btn.addAfter': 'Add after this…',
  'modal.visibleFields.description': 'Choose which optional fields appear in the task editor.',
  'modal.visibleFields.saving': 'Saving visible fields…',
  'modal.recurrence.commonPatterns': 'Common patterns:',
  'modal.validation.descriptionRequired': 'Description cannot be empty',
  'modal.validation.descriptionEmpty': 'Please enter a task description.',
  'modal.validation.templateNameEmpty': 'Template name cannot be empty',
  'modal.validation.invalidRecurrence': 'Invalid recurrence rule',
  'modal.recurrence.preview': 'Recurrence preview',
  'modal.recurrence.noRecurrence': 'No recurrence',
  'modal.recurrence.invalidRule': 'Invalid recurrence rule',
  'modal.autocomplete.wikilink': 'Search notes',
  'modal.autocomplete.tag': 'Search tags',
  'modal.autocomplete.noteSuggestions': 'Note suggestions',
  'modal.autocomplete.tagSuggestions': 'Tag suggestions',
  'modal.hiddenFieldLabel': ' (hidden in settings)',
  'modal.quickCapture.title': 'Quick capture',
  'modal.quickCapture.dueDate': 'Due date (optional)',
  'modal.quickCapture.dueDatePlaceholder': 'YYYY-MM-DD or tomorrow',
  'modal.quickCapture.dueInvalid': 'Enter a supported date, such as tomorrow or YYYY-MM-DD.',
  'modal.quickCapture.dueResolved': 'Due date will be saved as {{date}}.',
  'modal.quickCapture.capture': 'Capture',
  'modal.quickAdd.title': 'Quick add task',
  'modal.quickAdd.description': 'Plain English — dates, priority, tags, recurrence are parsed automatically. No emoji needed.',
  'modal.quickAdd.placeholder': 'e.g. Team standup every Monday at 9am #work  |  Call dentist Friday urgent  |  Review PR due Thursday for 30 minutes',
  'modal.quickAdd.previewPlaceholder': '(enter task text above)',
  'modal.quickAdd.previewHeading': 'Parsed task preview',
  'modal.quickAdd.submit': 'Add task',
  'googleCalendar.setup.localModeDescription': 'Local mode: use the calendar quick-add command, which applies #google-calendar without changing the vault-wide task filter.',
  'priority.normal': 'Normal',
  'priority.lowest': 'Lowest',
  'priority.low': 'Low',
  'priority.medium': 'Medium',
  'priority.high': 'High',
  'priority.highest': 'Highest',

  // Actions
  'action.complete': '✓ Complete',
  'action.archive': 'Archive',
  'action.delete': 'Delete',
  'action.edit': '✎ Edit',
  'action.view': 'View',
  'action.copyLink': 'Copy link',
  'action.postpone': '⏩ +1 day',
  'action.reschedule': '📅 Reschedule…',
  'action.priority': '🔼 Priority…',
  'action.tag': '🏷 Tag…',
  'action.untag': '🏷− Untag…',
  'action.status': 'Status',
  'action.menu': 'More options',
  'action.back': '← Back',
  'action.previous': '‹ Previous',
  'action.next': 'Next',
  'action.skip': '⏭ Skip',
  'action.pause': '⏸ Pause',
  'action.start': '▶ Start',
  'action.logNote': '📝 Log to Daily Note',
  'action.weeklyReview': '📋 Weekly Review',
  'action.runQuery': '🔍 Run Saved Query',
  'action.moreOptions': 'More options…',
  'action.nextInstance': '▶️ Go to next instance',
  'action.linkRelated': '🔗 Link related tasks',
  'action.createFollowUp': '➡️ Create follow-up task',
  'action.recommended': '💡 Recommended actions',
  'pomodoro.title': '🍅 Pomodoro Timer',
  'pomodoro.phase.work': '🎯 Work',
  'pomodoro.phase.shortBreak': '☕ Short Break',
  'pomodoro.phase.longBreak': '☕ Long Break',
  'pomodoro.roundInfo': 'Round {{round}} · {{work}}m work / {{break}}m break',
  'pomodoro.notice.logged': '🍅 Logged {{minutes}}m to task actual time',
  'pomodoro.notice.longBreak': '☕ Long break time!',
  'pomodoro.notice.shortBreak': '☕ Short break time!',
  'pomodoro.notice.work': '🎯 Work session starting!',

  // Notifications
  'notice.testLogEntry': 'Task Manager test entry logged',
  'notice.scanComplete': 'Task scan complete',
  'notice.commandCenterGenerated': 'Task Manager: generated Task Command Center.md',
  'notice.healthReportGenerated': 'Task Manager: generated Task Health Report.md',
  'notice.tasksScanned': 'Task Manager scanned {{file}}',
  'notice.stateCacheReset': 'Task Manager state cache reset',
  'notice.exportDone': 'Tasks exported',
  'notice.exportedTasks': 'Task Manager: exported {{count}} tasks to {{path}}',
  'notice.copiedAsCSV': 'Copied as CSV',
  'notice.copiedAsJSON': 'Copied as JSON',
  'notice.copiedAsMarkdown': 'Copied as Markdown table',
  'notice.copiedLink': 'Copied: {{link}}',
  'notice.syncComplete': 'Sync complete',
  'notice.syncError': 'Sync error',
  'notice.syncConflict': 'Sync conflict detected',
  'notice.todayScheduled': 'Task Manager: scheduled {{count}} tasks for today.',
  'notice.queryResultsCopied': 'Task Manager results copied',
  'notice.settingsAdded': 'Task Manager added Query File Defaults properties',
  'notice.canvasTasksIndexed': 'Task Manager: Canvas tasks are indexed read-only.',
  'notice.canvasTasksImported': 'Task Manager: imported {{count}} Canvas task(s).',
  'notice.tasksArchived': 'Task Manager: archived {{count}} completed task(s).',
  'notice.remindersConverted': 'Task Manager: converted {{count}} reminder marker(s).',
  'notice.projectPromoted': 'Task Manager: promoted to [[{{note}}]]',

  // Errors
  'error.noActiveFile': 'Task Manager: no active file.',
  'error.noTaskAtCursor': 'No task at cursor',
  'error.notATaskLine': 'Line is not a task or does not match global filter',
  'error.noDateField': 'Task Manager: no date field to postpone',
  'error.cannotToggleStatus': 'Cannot toggle status: line is not a task or does not match global filter',
  'error.cannotCycleStatus': 'Cannot cycle status: line is not a task',
  'error.cannotSetStatus': 'Cannot set status: line is not a task or does not match global filter',
  'error.lineAlreadyTask': 'Line is already a task',
  'error.cursorNotOnTask': 'Task Manager: cursor is not on a task line.',
  'error.tasksQueryError': 'Task Manager: query error',
  'error.dslDisabled': 'filter/sort/group by function expressions are disabled. Enable "Enable function expressions" in Task Manager settings.',
  'error.invalidRecurrence': 'Invalid recurrence rule',
  'error.queryError': 'Error parsing query',
  'error.taskCannotDependOnItself': 'Task Manager: a task cannot depend on itself.',
  'error.noTemplatesConfigured': 'Task Manager: no templates configured. Add templates in settings.',
  'error.todayPlanningSyntax': 'Task Manager: no Daily Plan templates configured. Add them in settings.',
  'error.noSavedQueries': 'Task Manager has no saved queries',
  'error.todoistNotConfigured': 'Task Manager: Todoist sync is not configured. Enable it and add your API key in settings.',
  'error.googleTasksNotConfigured': 'Task Manager: Google Tasks sync is not configured. Enable it and add your API key in settings.',
  'error.microsoftNotConfigured': 'Task Manager: Microsoft To Do client ID not configured. Add your Azure app client ID in settings.',
  'error.appleRemindersNotConfigured': 'Task Manager: Apple Reminders sync is not configured. Enable it in settings.',
  'error.icsImportNotConfigured': 'Task Manager: ICS import URL not configured. Set it in settings.',
  'error.mcpTokenGenerated': 'Task Manager: a new MCP auth token has been generated. Copy it from settings to your MCP client.',
  'error.noCanvasTasksFound': 'Task Manager: no Canvas checklist tasks found.',
  'error.noCompletedTasks': 'Task Manager: no completed tasks to archive.',
  'error.canvasTasksReadOnly': 'Task Manager: Canvas tasks are indexed read-only. Use "Import tasks from Canvas cards" to copy them into Markdown first.',
  'error.noStatisticsYet': 'Task Manager: no statistics yet.',
  'error.lifecycleTransferReconcile': 'Task Manager: pending archive/collect transfers could not be reconciled. No journal was discarded.',
  'warning.plaintextSecrets': 'Task Manager: secure credential storage is unavailable in this Obsidian version, so saved API keys and passwords are kept in plaintext in the plugin data file. Update Obsidian to 1.11.4 or later to enable encrypted storage.',

  // Settings - General
  'settings.section.general': 'General',
  'settings.section.query': 'Query',
  'settings.section.logging': 'Completion Log',
  'settings.section.sync': 'Sync',
  'settings.section.integrations': 'Integrations',
  'settings.section.ai': 'AI & Automation',
  'settings.section.mobile': 'Mobile',
  'settings.section.accessibility': 'Accessibility',
  'settings.section.views': 'Views',
  'settings.section.modal': 'Edit Modal',
  'settings.section.templates': 'Templates',
  'settings.searchLabel': 'Search settings',
  'settings.searchPlaceholder': 'Search names, descriptions, and sections…',
  'settings.searchClear': 'Clear settings search',
  'settings.searchCountSingular': '{{count}} setting found',
  'settings.searchCountPlural': '{{count}} settings found',
  'settings.validation.scanInterval': 'Enter a whole number from 1 to 1440 minutes.',

  // Settings - Language
  'settings.label.language': 'Language',
  'settings.desc.language': 'Choose your preferred language',
  'settings.language.english': 'English',
  'settings.language.chinese': '中文',
  'settings.language.german': 'Deutsch',
  'settings.language.spanish': 'Español',
  'settings.language.korean': '한국어',
  'settings.language.vietnamese': 'Tiếng Việt',
  'settings.language.russian': 'Русский',
  'settings.language.ukrainian': 'Українська',
  'settings.language.belarusian': 'Беларуская',
  'settings.language.portugueseBR': 'Português (Brasil)',

  // Settings - File Events
  'settings.label.enableFileEvents': 'Enable file events',
  'settings.desc.enableFileEvents': 'Watch vault file changes to detect task updates quickly.',
  'settings.label.enablePeriodicScan': 'Enable periodic scan',
  'settings.desc.enablePeriodicScan': 'Rescan the vault every few minutes to catch changes made outside Obsidian.',
  'settings.label.scanInterval': 'Scan interval (minutes)',
  'settings.desc.scanInterval': 'How often to rescan the vault when periodic scanning is enabled.',
  'settings.label.excludedFolders': 'Excluded folders',
  'settings.desc.excludedFolders': 'Comma-separated folder paths to skip during vault scanning (e.g. "Templates, Archive/2023"). Files inside these folders will not be parsed for tasks.',

  // Settings - Filters
  'settings.label.globalFilter': 'Global filter',
  'settings.desc.globalFilter': 'Optional text that must be present for a checklist item to be treated as a task, such as #task. Matching is case-insensitive.',
  'settings.label.removeGlobalFilter': 'Remove global filter from description',
  'settings.desc.removeGlobalFilter': 'Hide the global filter text in rendered task descriptions and stable task keys.',
  'settings.label.globalQuery': 'Global query',
  'settings.desc.globalQuery': 'Optional Tasks query instructions prepended to every task query block.',

  // Settings - Dates
  'settings.label.dateFormat': 'Date display format',
  'settings.label.timeFormat': 'Time display format',
  'settings.label.useFilenameAsScheduled': 'Use filename as Scheduled date for undated tasks',
  'settings.label.setCreatedDate': 'Set created date on new tasks',
  'settings.desc.setCreatedDate': 'Add today\'s created date when Task Manager creates a new task or a new recurrence.',
  'settings.label.setDoneDate': 'Set done date on completed tasks',
  'settings.desc.setDoneDate': 'Append a done date when Task Manager changes a task to a Done status.',
  'settings.label.setCancelledDate': 'Set cancelled date on cancelled tasks',
  'settings.desc.setCancelledDate': 'Append a cancelled date when Task Manager changes a task to a Cancelled status.',
  'settings.label.writeWikiLinks': 'Write dates as wiki links',
  'settings.desc.writeWikiLinks': 'When Task Manager writes a date to a task line, wrap it in [[…]] so it links to the matching daily note.',
  'settings.label.appendTimeWithDates': 'Append time with dates',
  'settings.desc.appendTimeWithDates': 'When Task Manager writes a done, created, or cancelled date, also append the current HH:MM time.',
  'settings.label.onlyFutureDates': 'Interpret relative dates as future dates',
  'settings.label.removeDateOnRecurrence': 'Remove scheduled date on recurrence',
  'settings.desc.removeDateOnRecurrence': 'When a recurring task also has a due or start date, remove the scheduled date from new occurrences.',
  'settings.label.skipPastOccurrences': 'Skip past occurrences on recurrence',
  'settings.desc.skipPastOccurrences': 'When completing a recurring task whose next occurrence falls in the past, skip forward until the next date is in the future.',
  'settings.label.advanceRecurrenceOnCancel': 'Advance recurrence when cancelling',
  'settings.desc.advanceRecurrenceOnCancel': 'When a recurring task is marked as cancelled, also create its next occurrence.',
  'settings.label.trackRecurrenceCount': 'Track recurrence count',
  'settings.desc.trackRecurrenceCount': 'Persist a monotonic completion count for recurring tasks for analytics and recovery. The `for N times` limit works independently.',

  // Settings - Modal Fields
  'settings.label.modalFields': 'Visible fields',
  'settings.desc.modalFields': 'Show this optional field in the Create/Edit task modal. Hidden fields keep existing values when editing tasks.',
  'settings.modal.showAll': 'Show all fields',
  'settings.modal.hideAll': 'Hide all fields',
  'settings.modal.priority': 'Priority',
  'settings.modal.dueDate': 'Due date',
  'settings.modal.scheduledDate': 'Scheduled date',
  'settings.modal.startDate': 'Start date',
  'settings.modal.createdDate': 'Created date',
  'settings.modal.doneDate': 'Done date',
  'settings.modal.cancelledDate': 'Cancelled date',
  'settings.modal.reminder': 'Reminder',
  'settings.modal.time': 'Time (⌚)',
  'settings.modal.recurrence': 'Recurrence',
  'settings.modal.onCompletion': 'On completion',
  'settings.modal.id': 'Id',
  'settings.modal.blockedBy': 'Blocked by (depends on)',
  'settings.modal.blocking': 'Blocking (blocked by this)',
  'settings.modal.effort': 'Effort estimate (⏱️)',
  'settings.modal.actual': 'Actual time logged (🕐)',
  'settings.modal.followUp': 'Follow-up date (👀)',

  // Settings - Task States
  'settings.label.taskStates': 'Task states',
  'settings.desc.taskStates': 'Configure the states available when toggling task status.',
  'settings.state.add': 'Add state',
  'settings.state.edit': 'Edit state',
  'settings.state.delete': 'Delete state',
  'settings.state.name': 'State name',
  'settings.state.type': 'State type',
  'settings.state.icon': 'State icon',
  'settings.state.marker': 'Checkbox marker',
  'settings.state.nextMarker': 'Next state marker',
  'settings.state.saved': 'Task states saved.',
  'settings.state.invalid': 'Task states were not saved. Markers must be unique and valid, names cannot be empty, and todo/done states are required.',
  'settings.state.moved': 'Moved {{state}} to position {{position}}.',

  // Settings - Templates
  'settings.label.templates': 'Task templates',
  'settings.desc.templates': 'Define reusable task skeletons that can be inserted via the quick-add command.',
  'settings.template.add': 'Add template',
  'settings.template.edit': 'Edit template',
  'settings.template.delete': 'Delete template',
  'settings.template.name': 'Template name',
  'settings.template.description': 'Default description',
  'settings.template.priority': 'Priority',
  'settings.template.recurrence': 'Recurrence',
  'settings.template.tags': 'Tags',
  'settings.template.onCompletion': 'On completion',

  // Settings - Saved Queries
  'settings.label.savedQueries': 'Saved queries',
  'settings.desc.savedQueries': 'Create reusable query blocks that can be inserted from the command palette.',
  'settings.query.add': 'Add saved query',
  'settings.query.edit': 'Edit saved query',
  'settings.query.delete': 'Delete saved query',
  'settings.query.name': 'Query name',
  'settings.query.description': 'Query description',
  'settings.query.content': 'Query content',

  // Settings - Logging
  'settings.label.completionLog': 'Completion log',
  'settings.label.enableCompletionLogging': 'Enable completion logging',
  'settings.desc.enableCompletionLogging': 'When enabled, completing a task may create or modify today’s daily note and append an entry under the configured log heading.',
  'settings.desc.completionLoggingDisabled': 'Completion logging is off. Task status, recurrence, habits, and analytics still update without writing to the daily note.',
  'settings.googleTasks.listId': 'Google Tasks list ID',
  'settings.googleTasks.listIdDesc': 'Google Tasks list to read and write. Use @default for the default list or paste a list ID; Test Google Tasks verifies it with an authenticated read.',
  'settings.googleTasks.listIdPlaceholder': '@default',
  'settings.integration.enabledNotVerified': 'Enabled — connection not yet verified',
  'settings.integration.disabled': 'Disabled',
  'settings.label.logTemplate': 'Log template',
  'settings.desc.logTemplate': 'Template for log entries when tasks are completed.',
  'settings.label.logHeading': 'Log heading',
  'settings.desc.logHeading': 'Append under this heading in the target note.',
  'settings.label.logFilePath': 'Log file path',
  'settings.desc.logFilePath': 'Where to append completed tasks.',
  'settings.label.appendStats': 'Append daily statistics summary',
  'settings.desc.appendStats': 'Append a brief statistics line to today\'s daily note after each task completion.',
  'settings.label.appendDailyNote': 'Add a source note link',
  'settings.desc.appendDailyNote': 'Add a source note link when the completed task is not in today\'s daily note.',

  // Settings - Completion Actions
  'settings.label.onCompletion': 'On completion',
  'settings.label.autoCompleteParent': 'Auto-complete parent tasks',
  'settings.desc.autoCompleteParent': 'When all direct child tasks are done or cancelled, automatically mark the parent task done.',
  'settings.label.nextInstanceAction': 'Next instance action',
  'settings.label.archiveAction': 'Archive action',
  'settings.label.collectAction': 'Collect action',
  'settings.label.archiveHeading': 'Archive heading',
  'settings.label.collectHeading': 'Collect heading',

  // Settings - Accessibility
  'settings.label.enableKeyboardNav': 'Enable keyboard navigation',
  'settings.desc.enableKeyboardNav': 'Add keyboard access keys to fields in the create/edit task dialog.',
  'settings.label.enableA11y': 'Enable accessibility features',
  'settings.desc.enableA11y': 'Enable screen reader support and other accessibility features.',
  'settings.label.enableMobileNotifications': 'Enable mobile notifications',
  'settings.desc.enableMobileNotifications': 'Use OS-level browser notifications for reminders instead of Obsidian in-app notices.',

  // Settings - Views
  'settings.label.inlineProgress': 'Show inline subtask progress bars',
  'settings.desc.inlineProgress': 'Render a live progress indicator (e.g. 2/5 ✓) after parent task lines in the editor.',
  'settings.label.functionExpressions': 'Enable function expressions in queries',
  'settings.desc.functionExpressions': 'Allow filter/sort/group by function expressions.',
  'settings.label.caldavEndpointTrust': 'Trust CalDAV endpoint',
  'settings.desc.caldavEndpointTrust': 'Required to connect. Trusts the hostname, DNS resolution, and private/local destinations; Obsidian cannot pin the address.',
  'settings.desc.caldavServerUrlTrust': 'HTTPS URL receiving credentials and task data. Use only a server and DNS environment you trust.',
  'settings.label.queryResultCounts': 'Show query result counts',
  'settings.desc.queryResultCounts': 'Show task count at the top or bottom of query results.',
  'settings.label.taskMetadataSuggestions': 'Show task metadata suggestions',
  'settings.desc.taskMetadataSuggestions': 'Show task metadata suggestions while editing task lines.',

  // Query and Results
  'query.noTasks': 'No tasks',
  'query.taskCount': '{{count}} task',
  'query.taskCountPlural': '{{count}} tasks',
  'query.toolbar.filter': 'Filter…',
  'query.toolbar.copy': 'Copy results',
  'query.toolbar.export': 'Export…',
  'query.toolbar.jsonExport': 'JSON',
  'query.toolbar.csvExport': 'CSV',
  'query.toolbar.canvasExport': 'Canvas',
  'query.error.prefix': 'Task Manager: query error',
  'query.error.dslDisabled': 'filter/sort/group by function expressions are disabled.',
  'query.error.invalidRecurrence': 'Invalid recurrence rule',
  'query.warning.recurrenceWarning': 'Recurrence rule could not be parsed',

  // Views
  'view.list': 'List',
  'view.table': 'Table',
  'view.kanban': 'Kanban',
  'view.calendar': 'Calendar',
  'view.gantt': 'Gantt',
  'view.stats': 'Statistics',
  'view.graph': 'Graph',
  'view.eisenhower': 'Eisenhower Matrix',
  'view.timeline': 'Timeline',

  // Kanban
  'kanban.column': 'Column',
  'kanban.addCard': 'Add task',
  'calendar.rescheduleHint': 'Open task editor to reschedule; drag for pointer rescheduling.',
  'dashboard.keyboardLayoutHint': 'Arrow keys move this widget. Shift plus arrow keys resize it.',
  'kanban.moveCard': 'Move',
  'kanban.allTasksShown': 'All Kanban tasks shown',

  // Eisenhower Matrix
  'eisenhower.q1': 'Do First (Urgent & Important)',
  'eisenhower.q2': 'Schedule (Important)',
  'eisenhower.q3': 'Delegate (Urgent)',
  'eisenhower.q4': 'Eliminate (Neither)',
  'eisenhower.urgent': 'Urgent',

  // Status
  'status.todo': 'Todo',
  'status.inProgress': 'In Progress',
  'status.done': 'Done',
  'status.cancelled': 'Cancelled',
  'status.blocked': 'Blocked',
  'status.deferred': 'Deferred',
  'status.onHold': 'On Hold',

  // Keyboard
  'keyboard.closeModal': 'Esc: Close',
  'keyboard.toggleCheckbox': 'Space: Toggle',
  'keyboard.cycleStatus': 'C: Cycle status',
  'keyboard.openDatePicker': 'D: Edit date',
  'keyboard.editTask': 'E: Edit task',
  'keyboard.deleteTask': 'Delete: Remove task',
  'keyboard.moveUp': '↑: Previous',
  'keyboard.moveDown': '↓: Next',
  'keyboard.focusSearch': 'Ctrl+F: Search',

  // Confirmations
  'confirm.deleteTask': 'Are you sure you want to delete this task?',
  'confirm.resetSettings': 'Are you sure you want to reset all settings to defaults?',
  'confirm.reset': 'Reset',
  'confirm.cancel': 'Cancel',

  // Help
  'help.title': 'Task Manager Help',
  'help.keyboard': 'Keyboard Shortcuts',
  'help.taskFormat': 'Task Format',
  'help.queryDSL': 'Query DSL',
  'help.viewMore': 'View more…',
  'help.contribute': 'Contribute',
  'help.contributors': 'Contributors',
  'help.license': 'License',
  'help.version': 'Version',
  'voice.error.recordingSizeLimit': 'Voice capture stopped because the recording reached the size limit.',
  'voice.error.recordingTooLarge': 'Voice capture: recording is too large to transcribe.',

};
const TRANSLATIONS: Partial<Record<Locale, Catalogue>> & { en: Catalogue } = { en: EN };



export const LOCALIZED_CORE_KEYS: ReadonlySet<TranslationKey> = new Set<TranslationKey>([
  'ui.panel.tasks', 'ui.tab.today', 'ui.tab.upcoming', 'ui.tab.all', 'ui.tab.agenda', 'ui.tab.thisFile', 'ui.tab.habits',
  'ui.loading', 'ui.retry', 'ui.sidebarLoadError', 'ui.noFileActive', 'ui.noMatchingTasks', 'ui.noTasksForToday', 'ui.taskCountSingular', 'ui.taskCountPlural',
  'ui.clearSearch', 'ui.clearGlyph', 'ui.refreshTasks', 'ui.skipToResults', 'ui.viewMode', 'ui.view.list', 'ui.view.kanban', 'ui.view.calendar',
  'ui.taskFilters', 'ui.resultPages', 'ui.searchLabel', 'ui.searchPlaceholder', 'ui.swipeComplete', 'ui.swipeDefer',
  'ui.swipeCompleted', 'ui.undo', 'ui.deferFailed', 'task.action.markComplete', 'task.action.markIncomplete', 'task.action.open',
  'task.action.openSource', 'task.action.defer', 'task.action.edit', 'table.addTagTitle', 'table.removeTagTitle', 'table.selectedCount',
  'table.tagToAdd', 'table.tagToRemove', 'table.add', 'table.remove', 'table.noTagSuggestions', 'table.suggestions', 'table.cancel',
  'table.customFieldTitle', 'table.customFieldDescription', 'table.customFieldName', 'table.customFieldValue', 'table.apply',
  'table.fieldNameRequired', 'table.addValue', 'table.noValuesSelected', 'table.removeValue', 'table.save', 'table.noMatchingTasks',
  'table.bulkPending', 'table.bulkSuccess', 'table.bulkPartial', 'table.bulkFailed',
  'advancedFind.title', 'advancedFind.resultsLabel', 'advancedFind.text', 'advancedFind.textPlaceholder', 'advancedFind.priority',
  'advancedFind.dueFrom', 'advancedFind.dueTo', 'advancedFind.tag', 'advancedFind.tagPlaceholder', 'advancedFind.folder',
  'advancedFind.folderPlaceholder', 'advancedFind.status', 'advancedFind.any', 'advancedFind.countSingular',
  'advancedFind.countPlural', 'advancedFind.moreResults', 'advancedFind.cannotOpen',
  'weeklyReview.title', 'weeklyReview.progress', 'weeklyReview.overdue.title', 'weeklyReview.overdue.description',
  'weeklyReview.inbox.title', 'weeklyReview.inbox.description', 'weeklyReview.undated.title', 'weeklyReview.undated.description',
  'weeklyReview.complete.title', 'weeklyReview.complete.summary', 'weeklyReview.complete.stats', 'weeklyReview.openTask',
  'weeklyReview.moreTasks', 'weeklyReview.next', 'weeklyReview.finish',
  'onboarding.title', 'onboarding.progress', 'onboarding.firstTask.title', 'onboarding.firstTask.description',
  'onboarding.firstTask.action', 'onboarding.sidebar.title', 'onboarding.sidebar.description', 'onboarding.sidebar.action',
  'onboarding.query.title', 'onboarding.query.description', 'onboarding.query.action', 'onboarding.remindLater',
  'onboarding.doNotShowAgain', 'onboarding.finish', 'onboarding.status.task', 'onboarding.status.panel',
  'onboarding.status.inserted', 'onboarding.status.copied', 'onboarding.status.copyFailed', 'onboarding.command.open',
  'queryBuilder.title', 'queryBuilder.filters', 'queryBuilder.addFilter', 'queryBuilder.sort', 'queryBuilder.addSort',
  'queryBuilder.group', 'queryBuilder.addGroup', 'queryBuilder.viewMode', 'queryBuilder.view', 'queryBuilder.layout',
  'queryBuilder.limit', 'queryBuilder.maxResults', 'queryBuilder.limitPlaceholder', 'queryBuilder.preview', 'queryBuilder.insert',
  'queryBuilder.removeFilter', 'queryBuilder.removeSort', 'queryBuilder.removeGroup', 'queryBuilder.status.updated',
  'queryBuilder.status.added', 'queryBuilder.status.removed', 'action.back', 'action.previous', 'action.next',
  'modal.btn.cancel', 'modal.btn.close', 'modal.validation.descriptionRequired', 'modal.quickCapture.title', 'modal.quickCapture.dueDate',
  'modal.quickCapture.dueDatePlaceholder', 'modal.quickCapture.dueInvalid', 'modal.quickCapture.dueResolved', 'modal.quickCapture.capture',
  'modal.field.description', 'modal.field.descriptionPlaceholder', 'modal.field.priority', 'settings.searchLabel', 'settings.searchPlaceholder',
  'settings.searchClear', 'settings.searchCountSingular', 'settings.searchCountPlural', 'settings.validation.scanInterval', 'status.todo', 'status.inProgress',
  'status.done', 'status.cancelled', 'status.blocked',
]);

export interface LocaleMetadata {
  tag: string;
  direction: 'ltr' | 'rtl';
}

const LOCALE_METADATA: Record<Locale, LocaleMetadata> = {
  en: { tag: 'en', direction: 'ltr' }, zh: { tag: 'zh', direction: 'ltr' }, de: { tag: 'de', direction: 'ltr' },
  es: { tag: 'es', direction: 'ltr' }, ko: { tag: 'ko', direction: 'ltr' }, vi: { tag: 'vi', direction: 'ltr' },
  ru: { tag: 'ru', direction: 'ltr' }, uk: { tag: 'uk', direction: 'ltr' }, be: { tag: 'be', direction: 'ltr' },
  'pt-BR': { tag: 'pt-BR', direction: 'ltr' },
};

function placeholders(value: string | undefined): string[] {
  return Array.from(value?.matchAll(/\{\{([^}]+)\}\}/gu) ?? [], (match) => match[1]).sort();
}

export function isLocaleCoreComplete(locale: Locale): boolean {
  const catalogue = TRANSLATIONS[locale];
  if (!catalogue) return false;
  return [...LOCALIZED_CORE_KEYS].every((key) => {
    const translated = catalogue[key];
    const english = TRANSLATIONS.en[key];
    return typeof translated === 'string' && typeof english === 'string'
      && placeholders(translated).join('\0') === placeholders(english).join('\0');
  });
}

export function isLocaleSelectable(locale: string): locale is Locale {
  return locale in TRANSLATIONS && isLocaleCoreComplete(locale as Locale);
}

let currentLocale: Locale = 'en';
let testLocaleMode: 'expanded' | 'rtl' | null = null;
const localeListeners = new Set<() => void>();

function notifyLocaleChanged(): void {
  for (const listener of localeListeners) listener();
}

export function subscribeLocaleChange(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => localeListeners.delete(listener);
}

export function setLocale(locale: string): void {
  testLocaleMode = null;
  const lower = locale.toLowerCase();
  const exact = (Object.keys(TRANSLATIONS) as Locale[]).find((key) => key.toLowerCase() === lower);
  const prefix = locale.split('-')[0].toLowerCase();
  const prefixMatch = (Object.keys(TRANSLATIONS) as Locale[]).find(
    (key) => key.toLowerCase() === prefix || key.toLowerCase().startsWith(`${prefix}-`),
  );
  const next = exact && isLocaleCoreComplete(exact) ? exact
    : prefixMatch && isLocaleCoreComplete(prefixMatch) ? prefixMatch : 'en';
  const changed = next !== currentLocale;
  currentLocale = next;
  if (changed) notifyLocaleChanged();
}

/** Enable pseudo-locales only inside layout/direction tests; they are never selectable or persisted. */
export function setTestLocale(mode: 'expanded' | 'rtl' | null): void {
  const changed = testLocaleMode !== mode || currentLocale !== 'en';
  currentLocale = 'en';
  testLocaleMode = mode;
  if (changed) notifyLocaleChanged();
}

export function getLocale(): Locale {
  return currentLocale;
}

export function getLocaleMetadata(): LocaleMetadata {
  if (testLocaleMode === 'rtl') return { tag: 'qps-rtl', direction: 'rtl' };
  if (testLocaleMode === 'expanded') return { tag: 'qps-ploc', direction: 'ltr' };
  return LOCALE_METADATA[currentLocale];
}

export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  const catalogue = TRANSLATIONS[currentLocale] ?? TRANSLATIONS.en;
  let str = catalogue[key] ?? TRANSLATIONS.en[key] ?? key;
  if (vars) {
    for (const [varKey, varVal] of Object.entries(vars)) {
      str = str.split(`{{${varKey}}}`).join(String(varVal));
    }
  }
  return testLocaleMode ? pseudoLocalize(str) : str;
}

/** Expand a UI string for pseudo-localization/overflow tests while preserving template tokens. */
export function pseudoLocalize(value: string): string {
  const accent: Record<string, string> = { a: 'á', e: 'ë', i: 'ï', o: 'ø', u: 'ü', A: 'Á', E: 'Ë', I: 'Ï', O: 'Ø', U: 'Ü' };
  const transformed = value.split(/(\{\{[^}]+\}\})/gu).map((part) => part.startsWith('{{') ? part : part.replace(/[aeiouAEIOU]/gu, (character) => accent[character] ?? character)).join('');
  return `［!! ${transformed} ${'~'.repeat(Math.ceil(value.length * 0.35))} !!］`;
}

export function detectLocale(): Locale {
  const lang = typeof navigator !== 'undefined' ? navigator.language : 'en';
  setLocale(lang);
  return currentLocale;
}

export function getAvailableLocales(): Locale[] {
  return (Object.keys(TRANSLATIONS) as Locale[]).filter(isLocaleCoreComplete);
}

export function getTranslationCoverage(locale: Locale): number {
  const total = Object.keys(TRANSLATIONS.en).length;
  if (total === 0) return 100;
  return Math.round((Object.keys(TRANSLATIONS[locale] ?? {}).length / total) * 100);
}

export function getCoreTranslationCoverage(locale: Locale): number {
  if (LOCALIZED_CORE_KEYS.size === 0) return 100;
  const translated = [...LOCALIZED_CORE_KEYS].filter((key) => {
    const value = TRANSLATIONS[locale]?.[key];
    return typeof value === 'string' && placeholders(value).join('\0') === placeholders(TRANSLATIONS.en[key]).join('\0');
  }).length;
  return Math.round((translated / LOCALIZED_CORE_KEYS.size) * 100);
}

export function getLocaleName(locale: Locale): string {
  const names: Record<Locale, string> = {
    'en': 'English',
    'zh': '中文',
    'de': 'Deutsch',
    'es': 'Español',
    'ko': '한국어',
    'vi': 'Tiếng Việt',
    'ru': 'Русский',
    'uk': 'Українська',
    'be': 'Беларуская',
    'pt-BR': 'Português (Brasil)',
  };
  return names[locale] || locale;
}
