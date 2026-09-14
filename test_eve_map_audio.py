from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

import eve_map_audio
from eve_map_audio import EveMapMusic


class EveMapMusicTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.track = Path(self.directory.name) / "ambient.mp3"
        self.track.write_bytes(b"not decoded by the fake MCI sender")
        self.commands = []
        self.play_state = 3
        self.windows = mock.patch.object(eve_map_audio.os, "name", "nt")
        self.windows.start()
        class Controls:
            def play(inner): self.commands.append("play")
            def pause(inner): self.commands.append("pause")
            def stop(inner): self.commands.append("stop")
        class Settings:
            autoStart = False
            @property
            def volume(inner): return 0
            @volume.setter
            def volume(inner, value): self.commands.append(f"volume:{value}")
        class Player:
            controls, settings = Controls(), Settings()
            @property
            def playState(inner): return self.play_state
            @property
            def URL(inner): return ""
            @URL.setter
            def URL(inner, value): self.commands.append(f"load:{value}")
        self.music = EveMapMusic(self.track, player_factory=Player, start_delay_ms=0)

    def tearDown(self):
        self.windows.stop()
        self.directory.cleanup()

    def test_first_start_uses_play_not_resume_and_keeps_windows_session_active(self):
        state = self.music.set_visible(True)
        self.assertTrue(state["available"])
        self.assertTrue(state["starting"])
        time.sleep(.03)
        self.assertTrue(any(command.startswith("load:") for command in self.commands))
        self.assertIn("play", self.commands)

    def test_duck_uses_validated_distance_and_preserves_user_volume(self):
        self.music.set_visible(True)
        self.music.set_volume(.42)
        state = self.music.duck(3)
        self.assertEqual(.35, state["duck_multiplier"])
        self.assertEqual(.42, state["volume"])
        self.assertEqual(.15, self.music.duck_multiplier(1))
        self.assertEqual(.60, self.music.duck_multiplier(5))

    def test_missing_track_is_a_clean_optional_feature_failure(self):
        missing = EveMapMusic(self.track.with_name("missing.mp3"), player_factory=lambda: None)
        self.assertFalse(missing.set_visible(True)["available"])
        self.assertFalse(self.commands)

    def test_play_waits_briefly_after_load_then_fades_in(self):
        music = EveMapMusic(self.track, player_factory=lambda: self.music._player_factory(), start_delay_ms=40)
        state = music.set_visible(True)
        self.assertTrue(state["starting"])
        self.assertNotIn("play", self.commands)
        time.sleep(.12)
        self.assertIn("play", self.commands)
        self.assertTrue(music.state()["playing"])

    def test_visible_returns_immediately_while_player_preloads_in_background(self):
        def slow_player_factory():
            time.sleep(.20)
            return self.music._player_factory()
        music = EveMapMusic(self.track, player_factory=slow_player_factory, start_delay_ms=0)
        started = time.monotonic()
        state = music.set_visible(True)
        self.assertLess(time.monotonic() - started, .08, "le bridge UI ne doit jamais attendre COM/player ready")
        self.assertTrue(state["starting"])

    def test_finished_track_advances_and_single_track_loops(self):
        second = self.track.with_name("ambient-second.mp3")
        second.write_bytes(b"second")
        music = EveMapMusic(self.track, player_factory=lambda: self.music._player_factory(), start_delay_ms=0)
        music.set_visible(True)
        time.sleep(.03)
        self.assertEqual(music.state()["playlist_count"], 2)
        self.assertTrue(music.advance_after_track_end())
        self.assertEqual(music.state()["track"], second.name)

        single_directory = tempfile.TemporaryDirectory()
        only = Path(single_directory.name) / "only.mp3"; only.write_bytes(b"one")
        loop = EveMapMusic(only, player_factory=lambda: self.music._player_factory(), start_delay_ms=0)
        loop.set_visible(True)
        self.assertTrue(loop.advance_after_track_end())
        self.assertEqual(loop.state()["track"], only.name)
        single_directory.cleanup()

    def test_previous_and_next_expose_a_private_display_name_playlist(self):
        second = self.track.with_name("ambient-second.mp3")
        second.write_bytes(b"second")
        self.music.set_visible(True)
        time.sleep(.03)
        self.assertEqual(self.music.next_track()["track"], second.name)
        self.assertEqual(self.music.previous_track()["track"], self.track.name)
        state = self.music.state()
        self.assertEqual(state["playlist"], sorted([self.track.name, second.name], key=str.casefold))
        self.assertNotIn(str(self.track.parent), " ".join(state["playlist"]))

    def test_shuffle_is_optional_and_reflected_in_state(self):
        self.assertTrue(self.music.set_shuffle(True)["shuffle"])
        self.assertFalse(self.music.set_shuffle(False)["shuffle"])

    def test_media_end_is_detected_and_starts_the_next_playlist_track(self):
        second = self.track.with_name("ambient-next.mp3")
        second.write_bytes(b"next")
        music = EveMapMusic(self.track, player_factory=lambda: self.music._player_factory(), start_delay_ms=0, monitor_interval=.01)
        music.set_visible(True)
        time.sleep(.04)
        self.play_state = 8
        time.sleep(.08)
        self.assertEqual(music.state()["track"], second.name)
        self.assertGreaterEqual(sum(command.startswith("load:") for command in self.commands), 2)

    def test_select_track_chooses_a_playlist_entry_by_index(self):
        second = self.track.with_name("ambient-selected.mp3")
        second.write_bytes(b"selected")
        self.music.set_visible(True)
        time.sleep(.03)
        before = self.music.state()
        selected_index = before["playlist"].index(second.name)
        state = self.music.select_track(selected_index)
        self.assertEqual(state["track"], second.name)
        self.assertEqual(state["track_index"], selected_index)

    def test_manual_track_change_fades_out_before_loading_the_next_track(self):
        second = self.track.with_name("ambient-dj.mp3")
        second.write_bytes(b"next")
        self.music.set_visible(True)
        time.sleep(.04)
        self.music.next_track()
        time.sleep(.60)
        second_load = next(index for index, command in enumerate(self.commands) if command == f"load:{second}")
        zero_volume = next(index for index, command in enumerate(self.commands) if command == "volume:0")
        self.assertLess(zero_volume, second_load)
        self.assertIn("pause", self.commands[:second_load])

if __name__ == "__main__":
    unittest.main()
