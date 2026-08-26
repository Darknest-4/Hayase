-- Extension reviews became reportable content in this release.
--
-- `reports.subject_type` is a fixed CHECK list, so a report against an
-- extension review was rejected by the database before the route ever saw it.
-- The existing `review` value means an *anime* review (table `reviews`) and
-- cannot be reused: the moderation queue resolves a subject by looking its id
-- up in the table the type names, and the two id spaces are different tables.

ALTER TABLE reports DROP CONSTRAINT reports_subject_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_subject_type_check
  CHECK (subject_type IN ('comment', 'post', 'topic', 'review', 'user', 'extension', 'message', 'extension_review'));
