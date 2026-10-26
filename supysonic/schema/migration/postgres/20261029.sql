-- Each show's "archive new episodes automatically" switch now decides what the
-- archive keeps of it. Before, EVERY show was archived whole; a server that
-- upgrades keeps doing exactly that until someone unticks a show.
UPDATE podcast_channel SET auto_archive = true;
