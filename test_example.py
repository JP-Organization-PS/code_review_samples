import unittest
from unittest.mock import patch, mock_open
import example

class TestExample(unittest.TestCase):
    def test_read_file_success(self):
        """Test reading a valid file"""
        test_content = "Hello world"
        with patch('builtins.open', mock_open(read_data=test_content)) as mock_file:
            result = example.read_file('test.txt')
            self.assertEqual(result, test_content)
            mock_file.assert_called_once_with('test.txt', 'r', encoding='utf-8')

    def test_read_file_not_found(self):
        """Test reading a non-existent file"""
        with patch('os.path.exists', return_value=False):
            result = example.read_file('nonexistent.txt')
            self.assertIsNone(result)

    def test_read_file_permission_error(self):
        """Test reading a file with permission error"""
        with patch('os.path.exists', return_value=True), \
             patch('os.path.isfile', return_value=True), \
             patch('builtins.open', side_effect=PermissionError):
            result = example.read_file('protected.txt')
            self.assertIsNone(result)

    def test_count_words(self):
        """Test word counting with various inputs"""
        test_cases = [
            ("Hello world", 2),
            ("  Hello   world  ", 2),
            ("Hello, world!", 2),
            ("", 0),
            ("one two three", 3),
            (" " * 100, 0)
        ]
        
        for text, expected in test_cases:
            with self.subTest(text=text):
                result = example.count_words(text)
                self.assertEqual(result, expected)

    @patch('sys.argv', ['example.py', 'test.txt'])
    @patch('example.read_file', return_value="Hello world")
    def test_main_success(self, mock_read_file):
        """Test main function with successful file reading"""
        with patch('builtins.print') as mock_print:
            example.main()
            mock_print.assert_called_with("Number of words in test.txt: 2")

    @patch('sys.argv', ['example.py'])
    def test_main_missing_argument(self):
        """Test main function with missing argument"""
        with patch('builtins.print') as mock_print:
            with self.assertRaises(SystemExit) as cm:
                example.main()
            mock_print.assert_called_with("Usage: python example.py <filename>")
            self.assertEqual(cm.exception.code, 1)

if __name__ == '__main__':
    unittest.main()
